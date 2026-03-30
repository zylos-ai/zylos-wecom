#!/usr/bin/env node
/**
 * zylos-wecom - WeCom Bot Service (WebSocket Long Connection)
 *
 * Connects to WeCom via WebSocket using the Intelligent Robot (智能机器人)
 * long connection protocol. No public IP or SSL required.
 *
 * Protocol: wss://openws.work.weixin.qq.com
 * Auth: botId + secret via aibot_subscribe frame
 * Heartbeat: ping every 30s
 */

import dotenv from 'dotenv';
import http from 'http';
import crypto from 'crypto';
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import WebSocket from 'ws';

// Load .env from ~/zylos/.env (absolute path, not cwd-dependent)
dotenv.config({ path: path.join(process.env.HOME, 'zylos/.env') });

import { getConfig, watchConfig, saveConfig, DATA_DIR, getCredentials, stopWatching } from './lib/config.js';
import { fetchAndSaveWecomDocMcpConfig } from './lib/mcp-config.js';
import { t } from './lib/i18n/cli-messages.js';
import { resolveRuntimeLocale, resolveWelcomeMessage } from './lib/i18n/runtime.js';

// C4 receive interface path
const C4_RECEIVE = path.join(process.env.HOME, 'zylos/.claude/skills/comm-bridge/scripts/c4-receive.js');

// State
let isShuttingDown = false;
let ws = null;
let reconnectTimer = null;
let heartbeatTimer = null;
let internalServer = null;
let reconnectDelay = 1000;
let authenticated = false;
let subscribeReqId = null; // Track subscribe req_id for auth response matching

function runtimeLocale() {
  return resolveRuntimeLocale(config);
}

function localizedRuntimeMessage(key, params = {}) {
  return t(runtimeLocale(), key, params);
}

// Initialize
let config = getConfig();
const INTERNAL_SECRET = crypto.randomUUID();
const TOKEN_FILE = path.join(DATA_DIR, '.internal-token');
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(TOKEN_FILE, INTERNAL_SECRET, { mode: 0o600 });
  // Enforce restrictive perms even if token file already existed.
  fs.chmodSync(TOKEN_FILE, 0o600);
} catch (err) {
  console.error(`[wecom] Failed to write internal token file: ${err.message}`);
}
console.log(`[wecom] ${localizedRuntimeMessage('runtime_starting')}`);
console.log(`[wecom] ${localizedRuntimeMessage('runtime_data_dir', { dir: DATA_DIR })}`);

// Ensure directories
const LOGS_DIR = path.join(DATA_DIR, 'logs');
const MEDIA_DIR = path.join(DATA_DIR, 'media');
fs.mkdirSync(LOGS_DIR, { recursive: true });
fs.mkdirSync(MEDIA_DIR, { recursive: true });

// State files
const USER_CACHE_PATH = path.join(DATA_DIR, 'user-cache.json');

if (!config.enabled) {
  console.log(`[wecom] ${localizedRuntimeMessage('runtime_disabled_exit')}`);
  process.exit(0);
}

// Verify required credentials
const creds = getCredentials();
if (!creds.bot_id || !creds.secret) {
  console.error(`[wecom] ${localizedRuntimeMessage('runtime_missing_creds')}`);
  process.exit(1);
}

// Watch for config changes
watchConfig((newConfig) => {
  console.log(`[wecom] ${localizedRuntimeMessage('runtime_config_reloaded')}`);
  config = newConfig;
  if (!newConfig.enabled) {
    console.log(`[wecom] ${localizedRuntimeMessage('runtime_disabled_stopping')}`);
    shutdown();
  }
});

// ============================================================
// Message deduplication
// ============================================================
const DEDUP_TTL = 10 * 60 * 1000; // 10 minutes
const processedMessages = new Map();

function isDuplicate(msgId) {
  if (!msgId) return false;
  if (processedMessages.has(msgId)) {
    console.log(`[wecom] ${localizedRuntimeMessage('runtime_duplicate_msg', { msgId })}`);
    return true;
  }
  processedMessages.set(msgId, Date.now());
  if (processedMessages.size > 500) {
    const now = Date.now();
    for (const [id, ts] of processedMessages) {
      if (now - ts > DEDUP_TTL) processedMessages.delete(id);
    }
  }
  return false;
}

const dedupCleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [id, ts] of processedMessages) {
    if (now - ts > DEDUP_TTL) processedMessages.delete(id);
  }
}, DEDUP_TTL);

// ============================================================
// Request ID tracking (for reply vs proactive send)
// ============================================================
const REQ_ID_TTL = 5 * 60 * 1000; // 5 minutes (WeCom stream timeout is 6 min)
const pendingRequests = new Map(); // msgId -> { reqId, chatId, userId, chatType, receivedAt }

function trackRequest(msgId, reqId, chatId, userId, chatType) {
  pendingRequests.set(String(msgId), {
    reqId,
    chatId,
    userId,
    chatType,
    receivedAt: Date.now(),
  });
}

function getRequest(msgId) {
  const entry = pendingRequests.get(String(msgId));
  if (!entry) return null;
  if (Date.now() - entry.receivedAt > REQ_ID_TTL) {
    pendingRequests.delete(String(msgId));
    return null;
  }
  return entry;
}

// Also track by target for proactive sends (with TTL to prevent memory leak)
const ACTIVATED_TARGET_TTL = 24 * 60 * 60 * 1000; // 24 hours
const activatedTargets = new Map(); // target -> { chatId, updatedAt }

const reqCleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of pendingRequests) {
    if (now - entry.receivedAt > REQ_ID_TTL) pendingRequests.delete(id);
  }
  // Clean up stale activated targets
  for (const [target, entry] of activatedTargets) {
    if (now - entry.updatedAt > ACTIVATED_TARGET_TTL) activatedTargets.delete(target);
  }
}, 60 * 1000);

// ============================================================
// Outbound send tracking (Promise-based delivery confirmation)
// ============================================================
const SEND_TIMEOUT = 10000; // 10 seconds
const pendingSends = new Map(); // reqId -> { resolve, timer }
const pendingRequestsByReqId = new Map(); // reqId -> { resolve, timer }
const MARKDOWN_MAX_BYTES = 2000;
const INTERNAL_BODY_MAX_BYTES = 1024 * 1024;

function resolvePendingSend(reqId, ok, errorMsg) {
  const pending = pendingSends.get(reqId);
  if (pending) {
    clearTimeout(pending.timer);
    pendingSends.delete(reqId);
    pending.resolve({ ok, error: errorMsg || null });
  }
}

function resolvePendingRequest(reqId, payload) {
  const pending = pendingRequestsByReqId.get(reqId);
  if (!pending) return false;
  clearTimeout(pending.timer);
  pendingRequestsByReqId.delete(reqId);
  pending.resolve(payload);
  return true;
}

// ============================================================
// User name cache with TTL
// ============================================================
const SENDER_NAME_TTL = 24 * 60 * 60 * 1000; // 24 hours (longer since we can't query API)
const userCacheMemory = new Map();
let _userCacheDirty = false;

function loadUserCacheFromFile() {
  try {
    if (fs.existsSync(USER_CACHE_PATH)) {
      const data = JSON.parse(fs.readFileSync(USER_CACHE_PATH, 'utf-8'));
      const now = Date.now();
      for (const [userId, name] of Object.entries(data)) {
        if (typeof name === 'string') {
          userCacheMemory.set(userId, { name, expireAt: now + SENDER_NAME_TTL });
        }
      }
      console.log(`[wecom] Loaded ${userCacheMemory.size} names from file cache`);
    }
  } catch (err) {
    console.log(`[wecom] Failed to load user cache file: ${err.message}`);
  }
}

function cacheUserName(userId, name) {
  if (!userId || !name) return;
  userCacheMemory.set(userId, { name, expireAt: Date.now() + SENDER_NAME_TTL });
  _userCacheDirty = true;
}

function getCachedUserName(userId) {
  if (!userId) return userId || 'unknown';
  const cached = userCacheMemory.get(userId);
  if (cached && Date.now() < cached.expireAt) {
    return cached.name;
  }
  return userId; // Fallback to userId
}

function persistUserCache() {
  if (!_userCacheDirty) return;
  _userCacheDirty = false;
  const obj = {};
  for (const [userId, entry] of userCacheMemory) {
    obj[userId] = entry.name;
  }
  const tmpPath = USER_CACHE_PATH + '.tmp';
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(obj, null, 2));
    fs.renameSync(tmpPath, USER_CACHE_PATH);
  } catch (err) {
    console.log(`[wecom] Failed to persist user cache: ${err.message}`);
    try { fs.unlinkSync(tmpPath); } catch {}
    _userCacheDirty = true;
  }
}

const userCachePersistInterval = setInterval(persistUserCache, 5 * 60 * 1000);
loadUserCacheFromFile();

// ============================================================
// Media download helpers (WeCom WS encrypted file/image URLs)
// ============================================================
function sanitizeFilename(name, fallback = 'file.bin') {
  const candidate = String(name || '').trim();
  const base = path.basename(candidate || fallback);
  const sanitized = base.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim();
  return sanitized || fallback;
}

function buildUniqueMediaFilename(name, suffix) {
  const sanitized = sanitizeFilename(name);
  const ext = path.extname(sanitized);
  const stem = ext ? sanitized.slice(0, -ext.length) : sanitized;
  const normalizedSuffix = String(suffix || Date.now()).replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${stem}_${normalizedSuffix}${ext}`;
}

function parseFilenameFromHeaders(headers, fallback) {
  const contentDisposition = headers.get('content-disposition') || '';
  const utf8Match = contentDisposition.match(/filename\*=UTF-8''([^;\s]+)/i);
  if (utf8Match) {
    try {
      return sanitizeFilename(decodeURIComponent(utf8Match[1]), fallback);
    } catch {}
  }

  const plainMatch = contentDisposition.match(/filename="?([^";\s]+)"?/i);
  if (plainMatch) {
    try {
      return sanitizeFilename(decodeURIComponent(plainMatch[1]), fallback);
    } catch {}
  }

  return sanitizeFilename(fallback, fallback);
}

function decryptMediaBuffer(encryptedBuffer, aesKey) {
  if (!Buffer.isBuffer(encryptedBuffer) || encryptedBuffer.length === 0) {
    throw new Error('Encrypted media payload is empty');
  }
  if (!aesKey) return encryptedBuffer;

  const key = Buffer.from(aesKey, 'base64');
  const iv = key.subarray(0, 16);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);

  // WeCom uses PKCS#7 padding to 32-byte boundaries, so strip manually.
  decipher.setAutoPadding(false);
  const decrypted = Buffer.concat([decipher.update(encryptedBuffer), decipher.final()]);
  const padLen = decrypted[decrypted.length - 1];

  if (padLen < 1 || padLen > 32 || padLen > decrypted.length) {
    throw new Error(`Invalid PKCS#7 padding: ${padLen}`);
  }
  for (let i = decrypted.length - padLen; i < decrypted.length; i++) {
    if (decrypted[i] !== padLen) {
      throw new Error('Invalid PKCS#7 padding bytes');
    }
  }

  return decrypted.subarray(0, decrypted.length - padLen);
}

async function readResponseBufferWithinLimit(response, maxBytes) {
  if (!response.body) {
    return Buffer.from(await response.arrayBuffer());
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      throw new Error(`Media download exceeded ${maxBytes} bytes`);
    }
    chunks.push(Buffer.from(value));
  }

  return Buffer.concat(chunks, total);
}

async function downloadIncomingMedia(url, aesKey, preferredName, fallbackPrefix, msgId) {
  if (!url) return null;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const maxDownloadBytes = Math.max(1, Number(config.media?.max_download_size_mb || 50)) * 1024 * 1024;
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength > maxDownloadBytes) {
    throw new Error(`Media download exceeded ${maxDownloadBytes} bytes`);
  }

  const encryptedBuffer = await readResponseBufferWithinLimit(response, maxDownloadBytes);
  const buffer = decryptMediaBuffer(encryptedBuffer, aesKey);
  const fallbackName = `${fallbackPrefix}_${String(msgId || Date.now()).replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  const filename = buildUniqueMediaFilename(
    parseFilenameFromHeaders(response.headers, preferredName || fallbackName),
    msgId || Date.now()
  );
  const savePath = path.join(MEDIA_DIR, filename);

  fs.writeFileSync(savePath, buffer);
  return { path: savePath, filename, size: buffer.length };
}

function utf8ByteLength(text) {
  return Buffer.byteLength(String(text || ''), 'utf8');
}

function sliceWithinUtf8Bytes(text, maxBytes) {
  const input = String(text || '');
  if (utf8ByteLength(input) <= maxBytes) return input;

  let low = 0;
  let high = input.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (utf8ByteLength(input.slice(0, mid)) <= maxBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return input.slice(0, low);
}

function splitMessage(text, maxBytes) {
  const input = String(text || '').trim();
  if (!input) return [];
  if (utf8ByteLength(input) <= maxBytes) return [input];

  const chunks = [];
  let remaining = input;

  while (remaining.length > 0) {
    if (utf8ByteLength(remaining) <= maxBytes) {
      chunks.push(remaining);
      break;
    }

    let candidate = sliceWithinUtf8Bytes(remaining, maxBytes);
    if (!candidate) break;

    let breakAt = candidate.length;
    const fenceMatches = candidate.match(/```/g);
    const insideCodeBlock = fenceMatches && fenceMatches.length % 2 !== 0;

    if (insideCodeBlock) {
      const lastFenceStart = candidate.lastIndexOf('```');
      const lineBeforeFence = remaining.lastIndexOf('\n', lastFenceStart - 1);
      if (lineBeforeFence > candidate.length * 0.2) {
        breakAt = lineBeforeFence;
      }
    } else {
      const lastParaBreak = candidate.lastIndexOf('\n\n');
      if (lastParaBreak > candidate.length * 0.3) {
        breakAt = lastParaBreak + 1;
      } else {
        const lastNewline = candidate.lastIndexOf('\n');
        if (lastNewline > candidate.length * 0.3) {
          breakAt = lastNewline;
        } else {
          const lastSpace = candidate.lastIndexOf(' ');
          if (lastSpace > candidate.length * 0.3) {
            breakAt = lastSpace;
          }
        }
      }
    }

    const nextChunk = remaining.slice(0, breakAt).trim();
    if (!nextChunk) {
      const hardChunk = candidate.trim();
      if (!hardChunk) break;
      chunks.push(hardChunk);
      remaining = remaining.slice(candidate.length).trim();
      continue;
    }

    chunks.push(nextChunk);
    remaining = remaining.slice(breakAt).trim();
  }

  return chunks;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================
// In-memory chat history for context
// ============================================================
const DEFAULT_HISTORY_LIMIT = 5;
const chatHistories = new Map();

function recordHistoryEntry(chatId, entry) {
  if (!chatHistories.has(chatId)) {
    chatHistories.set(chatId, []);
  }
  const history = chatHistories.get(chatId);
  if (entry.msgId && history.some(m => m.msgId === entry.msgId)) {
    return;
  }
  history.push(entry);
  const limit = config.message?.context_messages || DEFAULT_HISTORY_LIMIT;
  if (history.length > limit * 2) {
    chatHistories.set(chatId, history.slice(-limit));
  }
}

function getContextMessages(chatId, currentMsgId) {
  const history = chatHistories.get(chatId);
  if (!history || history.length === 0) return [];
  const limit = config.message?.context_messages || DEFAULT_HISTORY_LIMIT;
  const filtered = history.filter(m => m.msgId !== currentMsgId);
  const count = Math.min(limit, filtered.length);
  return filtered.slice(-count);
}

function escapeXml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/'/g, '&apos;')
    .replace(/"/g, '&quot;');
}

function formatC4Message(chatType, senderName, text, contextMessages = [], mediaPath = null, groupName = null) {
  const prefix = chatType === 'group'
    ? `[WeCom GROUP:${escapeXml(groupName || 'unknown')}]`
    : '[WeCom DM]';
  const parts = [`${prefix} ${escapeXml(senderName)} said: `];

  if (contextMessages.length > 0) {
    const contextLines = contextMessages
      .map((message) => `[${escapeXml(message.userName || message.userId || 'unknown')}]: ${escapeXml(message.text)}`)
      .join('\n');
    parts.push(`<group-context>\n${contextLines}\n</group-context>\n\n`);
  }

  parts.push(`<current-message>\n${escapeXml(text)}\n</current-message>`);

  let message = parts.join('');
  if (mediaPath) {
    message += ` ---- file: ${escapeXml(mediaPath)}`;
  }

  return message;
}

// ============================================================
// Helper: forward message to C4
// ============================================================
function forwardToC4(content, replyVia) {
  const args = [
    C4_RECEIVE,
    '--channel', 'wecom',
    '--endpoint', replyVia,
    '--json',
    '--content', content
  ];

  execFile('node', args, {
    encoding: 'utf8',
    timeout: 30000
  }, (error, stdout, stderr) => {
    if (error) {
      console.error(`[wecom] C4 forward error: ${error.message}`);
      if (stderr) console.error(`[wecom] C4 stderr: ${stderr}`);
    } else {
      console.log(`[wecom] Sent to C4: ${content.substring(0, 80)}...`);
    }
  });
}

// ============================================================
// Permission checking
// ============================================================
function isOwner(userId) {
  if (!config.owner?.bound) return false;
  return String(userId) === String(config.owner.user_id);
}

function checkDmPermission(userId) {
  if (isOwner(userId)) return true;
  const policy = config.dmPolicy || 'owner';
  switch (policy) {
    case 'open': return true;
    case 'owner': return false;
    case 'allowlist':
      return (config.dmAllowFrom || []).some(id => String(id) === String(userId));
    default: return false;
  }
}

function checkGroupPermission(chatId, userId, isMentioned) {
  const policy = config.groupPolicy || 'allowlist';
  if (isOwner(userId)) return true;
  switch (policy) {
    case 'disabled': return false;
    case 'open': return true;
    case 'allowlist': {
      const groupConfig = config.groups?.[chatId];
      if (!groupConfig) return false;
      // Check mode: "mention" requires @bot mention, "smart" receives all.
      // Legacy configs may only have requireMention without mode.
      const mode = groupConfig.mode || (groupConfig.requireMention === false ? 'smart' : 'mention');
      if (mode === 'mention' && !isMentioned) return false;
      // Check allowFrom sender restriction
      if (groupConfig.allowFrom && groupConfig.allowFrom.length > 0) {
        if (groupConfig.allowFrom.includes('*')) return true;
        return groupConfig.allowFrom.some(id => String(id) === String(userId));
      }
      return true;
    }
    default: return false;
  }
}

// ============================================================
// Owner auto-binding
// ============================================================
function tryBindOwner(userId, userName) {
  if (config.owner?.bound) return false;

  config.owner = {
    bound: true,
    user_id: String(userId),
    name: userName || String(userId)
  };

  if (saveConfig(config)) {
    console.log(`[wecom] ${t(runtimeLocale(), 'runtime_owner_bound', { userName, userId })}`);
    return true;
  }
  return false;
}

// ============================================================
// WebSocket frame builders
// ============================================================
function buildSubscribe() {
  subscribeReqId = crypto.randomUUID();
  return JSON.stringify({
    cmd: 'aibot_subscribe',
    headers: { req_id: subscribeReqId },
    body: {
      bot_id: creds.bot_id,
      secret: creds.secret
    }
  });
}

function buildPing() {
  return JSON.stringify({
    cmd: 'ping',
    headers: { req_id: crypto.randomUUID() }
  });
}

function buildRespondMsg(reqId, msgtype, body) {
  return JSON.stringify({
    cmd: 'aibot_respond_msg',
    headers: { req_id: reqId },
    body: { msgtype, ...body }
  });
}

function buildSendMsg(chatId, msgtype, body) {
  const reqId = crypto.randomUUID();
  return {
    reqId,
    data: JSON.stringify({
      cmd: 'aibot_send_msg',
      headers: { req_id: reqId },
      body: { chatid: chatId, msgtype, ...body }
    })
  };
}

function buildCommand(cmd, body, reqId = crypto.randomUUID()) {
  return {
    reqId,
    data: JSON.stringify({
      cmd,
      headers: { req_id: reqId },
      body
    })
  };
}

// ============================================================
// WebSocket message sending
// ============================================================

/**
 * Low-level send without delivery tracking (for ping, subscribe, welcome).
 */
function wsSendRaw(data) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.error(`[wecom] ${localizedRuntimeMessage('runtime_ws_not_connected')}`);
    return false;
  }
  try {
    ws.send(data);
    return true;
  } catch (err) {
    console.error(`[wecom] ${localizedRuntimeMessage('runtime_ws_send_error', { message: err.message })}`);
    return false;
  }
}

/**
 * Send a frame and wait for server ack/nack. Returns Promise<{ok, error}>.
 * Tracks the outbound req_id and resolves when server responds.
 */
function wsSend(data, reqId) {
  if (!ws || ws.readyState !== WebSocket.OPEN || !authenticated) {
    return Promise.resolve({ ok: false, error: 'WebSocket not ready' });
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingSends.delete(reqId);
      resolve({ ok: false, error: 'Send acknowledgement timeout', timeout: true });
    }, SEND_TIMEOUT);

    pendingSends.set(reqId, { resolve, timer });

    try {
      ws.send(data);
    } catch (err) {
      clearTimeout(timer);
      pendingSends.delete(reqId);
      resolve({ ok: false, error: err.message });
    }
  });
}

function wsRequest(cmd, body, options = {}) {
  const timeoutMs = options.timeoutMs || config.doc?.fetch_timeout_ms || 5000;
  const { reqId, data } = buildCommand(cmd, body);

  if (!ws || ws.readyState !== WebSocket.OPEN || !authenticated) {
    return Promise.reject(new Error('WebSocket not ready'));
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequestsByReqId.delete(reqId);
      reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    pendingRequestsByReqId.set(reqId, { resolve, timer });

    try {
      ws.send(data);
    } catch (err) {
      clearTimeout(timer);
      pendingRequestsByReqId.delete(reqId);
      reject(err);
    }
  });
}

async function refreshDocMcpConfig() {
  if (!ws || ws.readyState !== WebSocket.OPEN || !authenticated) {
    throw new Error('WebSocket not ready');
  }

  const refreshed = await fetchAndSaveWecomDocMcpConfig({
    accountId: 'default',
    request: (requestCmd, requestBody, options = {}) => wsRequest(requestCmd, requestBody, options),
    timeoutMs: config.doc?.fetch_timeout_ms || 5000,
    persistOpenClawCompat: config.doc?.persist_openclaw_compat !== false,
    log: (message) => console.log(message),
    error: (message) => console.error(message)
  });

  if (!refreshed) {
    throw new Error('Failed to refresh doc MCP config');
  }
  return refreshed;
}

/**
 * Send a reply to a message callback (using original reqId).
 * WeCom 智能机器人 WebSocket only supports markdown msgtype for aibot_respond_msg.
 */
function sendReply(reqId, text) {
  const data = buildRespondMsg(reqId, 'markdown', { markdown: { content: text } });
  return wsSend(data, reqId);
}

/**
 * Send a proactive message to a chat.
 * WeCom 智能机器人 WebSocket only supports markdown msgtype for aibot_send_msg.
 */
function sendProactive(chatId, text) {
  const { data, reqId } = buildSendMsg(chatId, 'markdown', { markdown: { content: text } });
  return wsSend(data, reqId);
}

function resolveChatTarget(target) {
  const entry = activatedTargets.get(target);
  return entry?.chatId || target;
}

async function sendProactiveChunks(target, chunks) {
  const chatId = resolveChatTarget(target);
  for (let i = 0; i < chunks.length; i++) {
    const result = await sendProactive(chatId, chunks[i]);
    if (!result.ok) return result;
    if (i < chunks.length - 1) {
      await sleep(500);
    }
  }
  return { ok: true, mode: 'proactive', chunks: chunks.length };
}

async function sendReplyThenProactive(target, req, chunks) {
  if (chunks.length === 0) {
    return { ok: true, mode: 'noop', chunks: 0 };
  }

  const first = await sendReply(req.reqId, chunks[0]);
  if (!first.ok) {
    console.log(`[wecom] Reply send failed, falling back to proactive: ${first.error || 'unknown error'}`);
    return sendProactiveChunks(target, chunks);
  }

  if (chunks.length === 1) {
    return { ok: true, mode: 'reply', chunks: 1 };
  }

  const restResult = await sendProactiveChunks(target, chunks.slice(1));
  if (!restResult.ok) return restResult;
  return { ok: true, mode: 'reply+proactive', chunks: chunks.length };
}

/**
 * Send a message to target, using reply mode if possible, falling back to proactive.
 * Returns Promise<{ok, error}>.
 */
async function sendMessage(target, msgId, text) {
  const content = String(text || '').trim();
  if (!content) return { ok: true, mode: 'noop', chunks: 0 };

  const req = msgId ? getRequest(msgId) : null;
  const chunks = splitMessage(content, MARKDOWN_MAX_BYTES);
  if (req) {
    console.log(`[wecom] Replying via markdown reqId ${req.reqId.substring(0, 8)}... to ${target}`);
    return sendReplyThenProactive(target, req, chunks);
  }

  console.log(`[wecom] Sending proactive to chatId: ${resolveChatTarget(target)}`);
  return sendProactiveChunks(target, chunks);
}

async function skipMessage(target, msgId) {
  void target;
  void msgId;
  return { ok: true, mode: 'skip' };
}

// ============================================================
// Process incoming WebSocket message
// ============================================================
async function processCallback(frame) {
  const { cmd, headers, body } = frame;

  if (cmd === 'aibot_msg_callback') {
    const reqId = headers?.req_id;
    const msgId = body?.msgid;
    const aibotId = body?.aibotid;
    const chatId = body?.chatid;
    const chatType = body?.chattype; // 'single' or 'group'
    const fromUser = body?.from?.userid;
    const fromName = body?.from?.name;
    const msgType = body?.msgtype;

    if (!fromUser) {
      console.log(`[wecom] ${t(runtimeLocale(), 'runtime_ignore_no_sender')}`);
      return;
    }

    // Deduplication
    if (isDuplicate(msgId)) return;

    // Track reqId for later reply
    trackRequest(msgId, reqId, chatId, fromUser, chatType);

    // Cache user name if available
    if (fromName) {
      cacheUserName(fromUser, fromName);
    }

    const senderName = fromName || getCachedUserName(fromUser);
    const isGroup = chatType === 'group';

    // Track activated target for proactive sends (store actual chatId)
    const now = Date.now();
    if (isGroup && chatId) {
      activatedTargets.set(chatId, { chatId, updatedAt: now });
    } else if (chatId) {
      activatedTargets.set(fromUser, { chatId, updatedAt: now });
    } else {
      activatedTargets.set(fromUser, { chatId: fromUser, updatedAt: now });
    }

    // Permission check
    // For groups, detect if bot was @mentioned (used for mention mode filtering)
    const isMentioned = isGroup && aibotId && (
      body?.text?.content?.includes(`@${aibotId}`)
      || body?.mixed?.items?.some((item) => item?.msgtype === 'text' && item?.text?.content?.includes(`@${aibotId}`))
    );
    if (isGroup) {
      if (!checkGroupPermission(chatId, fromUser, isMentioned)) {
        console.log(`[wecom] ${t(runtimeLocale(), 'runtime_group_blocked', { senderName, chatId })}`);
        return;
      }
    } else {
      if (!config.owner?.bound) {
        tryBindOwner(fromUser, senderName);
      }
      if (!checkDmPermission(fromUser)) {
        console.log(`[wecom] ${t(runtimeLocale(), 'runtime_dm_blocked', {
          senderName,
          userId: fromUser
        })}`);
        return;
      }
    }

    // Extract message content
    let textContent = '';
    let filePath = '';

    switch (msgType) {
      case 'text':
        textContent = body?.text?.content || '';
        break;
      case 'image':
        try {
          const imageDownload = await downloadIncomingMedia(
            body?.image?.url,
            body?.image?.aeskey,
            body?.image?.filename,
            'wecom-image',
            msgId
          );
          if (imageDownload) {
            filePath = imageDownload.path;
            textContent = `[image: ${imageDownload.filename}]`;
          } else {
            textContent = `[image]`;
          }
        } catch (err) {
          console.error(`[wecom] Failed to download image ${msgId}: ${err.message}`);
          textContent = `[image]`;
        }
        break;
      case 'voice':
        textContent = body?.voice?.transcription || `[voice message]`;
        break;
      case 'video':
        textContent = `[video message]`;
        break;
      case 'file':
        try {
          const fileDownload = await downloadIncomingMedia(
            body?.file?.url,
            body?.file?.aeskey,
            body?.file?.filename,
            'wecom-file',
            msgId
          );
          if (fileDownload) {
            filePath = fileDownload.path;
            textContent = `[file: ${fileDownload.filename}]`;
          } else {
            textContent = `[file: ${body?.file?.filename || 'unknown'}]`;
          }
        } catch (err) {
          console.error(`[wecom] Failed to download file ${msgId}: ${err.message}`);
          textContent = `[file: ${body?.file?.filename || 'unknown'}]`;
        }
        break;
      case 'mixed': {
        // Mixed message: text + images
        const parts = [];
        if (body?.mixed?.items) {
          for (const item of body.mixed.items) {
            if (item.msgtype === 'text') {
              parts.push(item.text?.content || '');
            } else if (item.msgtype === 'image') {
              parts.push('[image]');
            }
          }
        }
        textContent = parts.join(' ') || '[mixed message]';
        break;
      }
      default:
        textContent = `[${msgType} message]`;
        break;
    }

    if (!textContent) return;

    // Strip @bot mention from group messages (only strip the bot's own mention)
    if (isGroup && aibotId) {
      textContent = textContent.replace(new RegExp(`@${aibotId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`, 'g'), '').trim();
    }

    // Record to history
    recordHistoryEntry(isGroup ? chatId : fromUser, {
      msgId,
      userId: fromUser,
      userName: senderName,
      text: textContent,
      timestamp: new Date().toISOString()
    });

    if (isGroup) {
      const groupName = config.groups?.[chatId]?.name || chatId;
      const context = getContextMessages(chatId, msgId);
      const formattedMessage = formatC4Message('group', senderName, textContent, context, filePath, groupName);
      const endpoint = `${chatId}|type:group|msg:${msgId}`;
      forwardToC4(formattedMessage, endpoint);
    } else {
      const context = getContextMessages(fromUser, msgId);
      const formattedMessage = formatC4Message('p2p', senderName, textContent, context, filePath);
      const endpoint = `${fromUser}|type:p2p|msg:${msgId}`;
      forwardToC4(formattedMessage, endpoint);
    }

    console.log(`[wecom] ${localizedRuntimeMessage('runtime_message_summary', {
      kind: localizedRuntimeMessage(isGroup ? 'runtime_kind_group' : 'runtime_kind_dm'),
      senderName,
      content: textContent.slice(0, 100)
    })}`);

  } else if (cmd === 'aibot_event_callback') {
    const eventType = body?.event?.eventtype || body?.msgtype;
    console.log(`[wecom] ${t(runtimeLocale(), 'runtime_event_received', { eventType })}`);

    // Handle enter_chat event
    if (eventType === 'enter_chat') {
      const reqId = headers?.req_id;
      if (reqId) {
        const welcome = resolveWelcomeMessage(config);
        const welcomeText = welcome.text;
        if (welcomeText) {
          // Auto-reply with configured welcome message
          wsSendRaw(JSON.stringify({
            cmd: 'aibot_respond_welcome_msg',
            headers: { req_id: reqId },
            body: { msgtype: 'text', text: { content: welcomeText } }
          }));
          console.log(`[wecom] ${localizedRuntimeMessage(
            welcome.source === 'localized' ? 'runtime_welcome_locale' : 'runtime_welcome_fallback'
          )}`);
        }
        // If welcome_text is empty, the event is silently ignored
        // (Claude handles greetings via normal message flow)
      }
    }
  }
}

// ============================================================
// WebSocket connection management
// ============================================================
function startHeartbeat() {
  stopHeartbeat();
  const interval = config.ws?.heartbeat_interval || 30000;
  heartbeatTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      wsSendRaw(buildPing());
    }
  }, interval);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function connect() {
  if (isShuttingDown) return;

  const wsUrl = config.ws?.url || 'wss://openws.work.weixin.qq.com';
  console.log(`[wecom] ${localizedRuntimeMessage('runtime_connecting', { url: wsUrl })}`);

  ws = new WebSocket(wsUrl);

  ws.on('open', () => {
    console.log(`[wecom] ${localizedRuntimeMessage('runtime_ws_authenticating')}`);
    wsSendRaw(buildSubscribe());
  });

  ws.on('message', (data) => {
    try {
      const frame = JSON.parse(data.toString());
      const cmd = frame.cmd;
      const frameReqId = frame.headers?.req_id;

      // Handle authentication response (match by saved subscribeReqId)
      if (cmd === 'aibot_subscribe' || (!cmd && frameReqId === subscribeReqId && !authenticated)) {
        if (frame.errcode === 0 || frame.body?.code === 0) {
          authenticated = true;
          subscribeReqId = null;
          reconnectDelay = config.ws?.reconnect_initial_delay || 1000;
          console.log(`[wecom] ${t(runtimeLocale(), 'runtime_authenticated')}`);
          startHeartbeat();
          void refreshDocMcpConfig().catch(() => {});
        } else {
          console.error(`[wecom] ${t(runtimeLocale(), 'runtime_auth_failed', {
            frame: JSON.stringify(frame)
          })}`);
          subscribeReqId = null;
          ws.close();
        }
        return;
      }

      // Handle pong
      if (cmd === 'pong' || cmd === 'ping') {
        return;
      }

      // Handle message/event callbacks
      if (cmd === 'aibot_msg_callback' || cmd === 'aibot_event_callback') {
        processCallback(frame).catch(err => {
          console.error(`[wecom] ${localizedRuntimeMessage('runtime_callback_error', { message: err.message })}`);
        });
        return;
      }

      // Handle send/respond acknowledgements (resolve pending send promises)
      if (cmd === 'aibot_respond_msg' || cmd === 'aibot_send_msg') {
        const ok = !frame.body?.code || frame.body.code === 0;
        if (!ok) {
          console.error(`[wecom] ${localizedRuntimeMessage('runtime_send_error_body', {
            cmd,
            body: JSON.stringify(frame.body)
          })}`);
        }
        if (frameReqId) resolvePendingSend(frameReqId, ok, ok ? null : frame.body?.msg);
        return;
      }

      // Handle generic responses without cmd (e.g., error frames)
      if (!cmd && frame.errcode !== undefined && frameReqId) {
        if (resolvePendingRequest(frameReqId, frame)) {
          return;
        }
        const ok = frame.errcode === 0;
        if (!ok) {
          console.error(`[wecom] ${localizedRuntimeMessage('runtime_send_error_frame', {
            frame: JSON.stringify(frame)
          })}`);
        }
        resolvePendingSend(frameReqId, ok, ok ? null : frame.errmsg);
        return;
      }

      // Handle request/response style commands such as aibot_get_mcp_config.
      if (frameReqId && resolvePendingRequest(frameReqId, frame)) {
        return;
      }

      // Log unknown frames with full content for debugging
      console.log(`[wecom] ${localizedRuntimeMessage('runtime_unknown_frame', {
        frame: JSON.stringify(frame).substring(0, 500)
      })}`);
    } catch (err) {
      console.error(`[wecom] ${localizedRuntimeMessage('runtime_parse_failed', { message: err.message })}`);
    }
  });

  ws.on('close', (code, reason) => {
    authenticated = false;
    subscribeReqId = null;
    stopHeartbeat();
    // Reject all pending sends
    for (const [reqId, pending] of pendingSends) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, error: 'WebSocket closed' });
    }
    pendingSends.clear();
    for (const [reqId, pending] of pendingRequestsByReqId) {
      clearTimeout(pending.timer);
      pending.resolve({ errcode: -1, errmsg: 'WebSocket closed' });
    }
    pendingRequestsByReqId.clear();
    const reasonStr = reason?.toString() || 'unknown';
    console.log(`[wecom] ${localizedRuntimeMessage('runtime_ws_closed', { code, reason: reasonStr })}`);
    scheduleReconnect();
  });

  ws.on('error', (err) => {
    // Suppress expected close errors
    if (err.message?.includes('WebSocket was closed') || isShuttingDown) return;
    console.error(`[wecom] ${localizedRuntimeMessage('runtime_ws_error', { message: err.message })}`);
  });
}

function scheduleReconnect() {
  if (isShuttingDown) return;
  if (reconnectTimer) return;

  const maxDelay = config.ws?.reconnect_max_delay || 30000;
  const delay = Math.min(reconnectDelay, maxDelay);

  // Add jitter (±25%)
  const jitter = delay * (0.75 + Math.random() * 0.5);
  const actualDelay = Math.round(jitter);

  console.log(`[wecom] ${localizedRuntimeMessage('runtime_reconnecting', {
    seconds: Math.round(actualDelay / 1000)
  })}`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectDelay = Math.min(reconnectDelay * 2, maxDelay);
    connect();
  }, actualDelay);
}

// ============================================================
// Internal HTTP API (for send.js communication)
// ============================================================
function startInternalServer() {
  const port = config.internal_port || 4459;

  internalServer = http.createServer((req, res) => {
    // Auth check
    if (req.headers['x-internal-token'] !== INTERNAL_SECRET) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid internal token' }));
      return;
    }

    let body = '';
    let bodySize = 0;
    req.on('data', chunk => {
      bodySize += chunk.length;
      if (bodySize > INTERNAL_BODY_MAX_BYTES) {
        if (!res.headersSent) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Request body too large' }));
        }
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('end', async () => {
      if (res.headersSent) return;
      try {
        const data = JSON.parse(body);
        await handleInternalRequest(req.url, data, res);
      } catch (err) {
        if (!res.headersSent) {
          const status = err instanceof SyntaxError ? 400 : 500;
          const error = err instanceof SyntaxError ? 'Invalid JSON' : 'Internal server error';
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error }));
        }
        if (!(err instanceof SyntaxError)) {
          console.error(`[wecom] ${localizedRuntimeMessage('runtime_internal_request_failed', {
            message: err.message
          })}`);
        }
      }
    });
  });

  internalServer.listen(port, '127.0.0.1', () => {
    console.log(`[wecom] ${localizedRuntimeMessage('runtime_internal_api', { port })}`);
  });
}

async function handleInternalRequest(url, data, res) {
  if (url === '/internal/send') {
    const { target, msgId, content, skip } = data;
    if (!target || (!skip && !content)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing target or content' }));
      return;
    }

    const result = skip ? await skipMessage(target, msgId) : await sendMessage(target, msgId, content);
    res.writeHead(result.ok ? 200 : 500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));

  } else if (url === '/internal/record-outgoing') {
    const { chatId, text } = data;
    if (!chatId || !text) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing chatId or text' }));
      return;
    }

    recordHistoryEntry(String(chatId), {
      msgId: `out_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      userId: 'bot',
      userName: 'bot',
      text: String(text).slice(0, 4000),
      timestamp: new Date().toISOString()
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));

  } else if (url === '/internal/refresh-doc-mcp') {
    try {
      const refreshed = await refreshDocMcpConfig();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, config: refreshed }));
    } catch (err) {
      const status = err.message === 'WebSocket not ready' ? 503 : 500;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }

  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }
}

// ============================================================
// Startup
// ============================================================
startInternalServer();
connect();

console.log(`[wecom] ${localizedRuntimeMessage('runtime_bot_id', { botId: `${creds.bot_id.substring(0, 8)}...` })}`);

// ============================================================
// Graceful shutdown
// ============================================================
async function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`[wecom] ${localizedRuntimeMessage('runtime_shutting_down')}`);

  // Stop config watcher
  stopWatching();

  // Clear intervals
  clearInterval(dedupCleanupInterval);
  clearInterval(reqCleanupInterval);
  clearInterval(userCachePersistInterval);
  stopHeartbeat();

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  // Persist user cache
  persistUserCache();

  // Close WebSocket
  if (ws) {
    try { ws.close(1000, 'shutdown'); } catch {}
  }

  // Close internal server
  if (internalServer) {
    internalServer.close(() => {
      console.log(`[wecom] ${localizedRuntimeMessage('runtime_internal_server_closed')}`);
    });
  }

  // Force exit after timeout
  setTimeout(() => {
    console.log(`[wecom] ${localizedRuntimeMessage('runtime_force_exit')}`);
    process.exit(0);
  }, 5000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

process.on('uncaughtException', (err) => {
  console.error(`[wecom] ${localizedRuntimeMessage('runtime_uncaught_exception', { message: err.message })}`);
  console.error(err.stack);
});

process.on('unhandledRejection', (reason) => {
  const reasonText = reason instanceof Error ? reason.message : String(reason);
  console.error(`[wecom] ${localizedRuntimeMessage('runtime_unhandled_rejection', { reason: reasonText })}`);
});
