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

// Initialize
let config = getConfig();
const INTERNAL_SECRET = crypto.randomUUID();
const TOKEN_FILE = path.join(DATA_DIR, '.internal-token');
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(TOKEN_FILE, INTERNAL_SECRET, { mode: 0o600 });
} catch (err) {
  console.error(`[wecom] Failed to write internal token file: ${err.message}`);
}
console.log(`[wecom] Starting (WebSocket mode)...`);
console.log(`[wecom] Data directory: ${DATA_DIR}`);

// Ensure directories
const LOGS_DIR = path.join(DATA_DIR, 'logs');
const MEDIA_DIR = path.join(DATA_DIR, 'media');
fs.mkdirSync(LOGS_DIR, { recursive: true });
fs.mkdirSync(MEDIA_DIR, { recursive: true });

// State files
const USER_CACHE_PATH = path.join(DATA_DIR, 'user-cache.json');

if (!config.enabled) {
  console.log(`[wecom] Component disabled in config, exiting.`);
  process.exit(0);
}

// Verify required credentials
const creds = getCredentials();
if (!creds.bot_id || !creds.secret) {
  console.error(`[wecom] ERROR: WECOM_BOT_ID and WECOM_BOT_SECRET must be set in ~/zylos/.env`);
  process.exit(1);
}

// Watch for config changes
watchConfig((newConfig) => {
  console.log(`[wecom] Config reloaded`);
  config = newConfig;
  if (!newConfig.enabled) {
    console.log(`[wecom] Component disabled, stopping...`);
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
    console.log(`[wecom] Duplicate MsgId ${msgId}, skipping`);
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
  pendingRequests.set(String(msgId), { reqId, chatId, userId, chatType, receivedAt: Date.now() });
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

// Also track by target for proactive sends
const activatedTargets = new Map(); // target -> chatId (for proactive sends)

const reqCleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of pendingRequests) {
    if (now - entry.receivedAt > REQ_ID_TTL) pendingRequests.delete(id);
  }
}, 60 * 1000);

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

function checkGroupPermission(chatId, userId) {
  const policy = config.groupPolicy || 'allowlist';
  if (isOwner(userId)) return true;
  switch (policy) {
    case 'disabled': return false;
    case 'open': return true;
    case 'allowlist': {
      const groupConfig = config.groups?.[chatId];
      if (!groupConfig) return false;
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
    console.log(`[wecom] Owner bound: ${userName} (${userId})`);
    return true;
  }
  return false;
}

// ============================================================
// WebSocket frame builders
// ============================================================
function buildSubscribe() {
  return JSON.stringify({
    cmd: 'aibot_subscribe',
    headers: { req_id: crypto.randomUUID() },
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
  return JSON.stringify({
    cmd: 'aibot_send_msg',
    headers: { req_id: crypto.randomUUID() },
    body: { chatid: chatId, msgtype, ...body }
  });
}

// ============================================================
// WebSocket message sending
// ============================================================
function wsSend(data) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.error('[wecom] WebSocket not connected, cannot send');
    return false;
  }
  try {
    ws.send(data);
    return true;
  } catch (err) {
    console.error(`[wecom] WebSocket send error: ${err.message}`);
    return false;
  }
}

/**
 * Send a reply to a message callback (using original reqId).
 */
function sendReply(reqId, text) {
  const useMarkdown = config.message?.useMarkdown;
  if (useMarkdown) {
    return wsSend(buildRespondMsg(reqId, 'markdown', { markdown: { content: text } }));
  }
  return wsSend(buildRespondMsg(reqId, 'text', { text: { content: text } }));
}

/**
 * Send a proactive message to a chat.
 */
function sendProactive(chatId, text) {
  const useMarkdown = config.message?.useMarkdown;
  if (useMarkdown) {
    return wsSend(buildSendMsg(chatId, 'markdown', { markdown: { content: text } }));
  }
  return wsSend(buildSendMsg(chatId, 'text', { text: { content: text } }));
}

/**
 * Send a message to target, using reply mode if possible, falling back to proactive.
 */
function sendMessage(target, msgId, text) {
  // Try reply mode first (using tracked reqId)
  if (msgId) {
    const req = getRequest(msgId);
    if (req) {
      console.log(`[wecom] Replying via reqId ${req.reqId.substring(0, 8)}... to ${target}`);
      return sendReply(req.reqId, text);
    }
  }

  // Fallback: proactive send
  // For proactive sends, we need the chatId
  // For DMs, chatId = userId; for groups, chatId = group chatId
  const chatId = activatedTargets.get(target) || target;
  console.log(`[wecom] Sending proactive to chatId: ${chatId}`);
  return sendProactive(chatId, text);
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
      console.log('[wecom] Ignoring message with no sender');
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

    // Track activated target for proactive sends
    if (isGroup && chatId) {
      activatedTargets.set(chatId, chatId);
    } else {
      activatedTargets.set(fromUser, fromUser);
    }

    // Permission check
    if (isGroup) {
      if (!checkGroupPermission(chatId, fromUser)) {
        console.log(`[wecom] Group message from ${senderName} in ${chatId} blocked by policy`);
        return;
      }
    } else {
      if (!config.owner?.bound) {
        tryBindOwner(fromUser, senderName);
      }
      if (!checkDmPermission(fromUser)) {
        console.log(`[wecom] DM from ${senderName} (${fromUser}) blocked by policy`);
        return;
      }
    }

    // Extract message content
    let textContent = '';

    switch (msgType) {
      case 'text':
        textContent = body?.text?.content || '';
        break;
      case 'image':
        textContent = `[image, url: ${body?.image?.url || 'N/A'}]`;
        break;
      case 'voice':
        textContent = body?.voice?.transcription || `[voice message]`;
        break;
      case 'video':
        textContent = `[video message]`;
        break;
      case 'file':
        textContent = `[file: ${body?.file?.filename || 'unknown'}]`;
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

    // Strip @bot mention prefix from group messages
    if (isGroup) {
      textContent = textContent.replace(/^@\S+\s*/, '');
    }

    // Record to history
    recordHistoryEntry(isGroup ? chatId : fromUser, {
      msgId,
      userId: fromUser,
      userName: senderName,
      text: textContent,
      timestamp: new Date().toISOString()
    });

    // Build C4 formatted message
    let formattedMessage;

    if (isGroup) {
      const groupName = config.groups?.[chatId]?.name || chatId;
      formattedMessage = `[WeCom GROUP:${groupName}] ${senderName} said: ${textContent}`;

      const context = getContextMessages(chatId, msgId);
      if (context.length > 0) {
        const contextLines = context.map(m => `${m.userName}: ${m.text}`).join('\n');
        formattedMessage += `\n\n--- recent context ---\n${contextLines}`;
      }

      const endpoint = `${chatId}|type:group|msg:${msgId}`;
      forwardToC4(formattedMessage, endpoint);
    } else {
      formattedMessage = `[WeCom DM] ${senderName} said: ${textContent}`;

      const context = getContextMessages(fromUser, msgId);
      if (context.length > 0) {
        const contextLines = context.map(m => `${m.userName}: ${m.text}`).join('\n');
        formattedMessage += `\n\n--- recent context ---\n${contextLines}`;
      }

      const endpoint = `${fromUser}|type:p2p|msg:${msgId}`;
      forwardToC4(formattedMessage, endpoint);
    }

    console.log(`[wecom] ${isGroup ? 'Group' : 'DM'} from ${senderName}: ${textContent.slice(0, 100)}`);

  } else if (cmd === 'aibot_event_callback') {
    const eventType = body?.event?.eventtype || body?.msgtype;
    console.log(`[wecom] Event received: ${eventType}`);

    // Handle enter_chat event
    if (eventType === 'enter_chat') {
      const reqId = headers?.req_id;
      if (reqId) {
        // Send welcome message if configured
        const welcomeText = '你好！有什么可以帮你的？';
        wsSend(JSON.stringify({
          cmd: 'aibot_respond_welcome_msg',
          headers: { req_id: reqId },
          body: { msgtype: 'text', text: { content: welcomeText } }
        }));
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
      wsSend(buildPing());
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
  console.log(`[wecom] Connecting to ${wsUrl}...`);

  ws = new WebSocket(wsUrl);

  ws.on('open', () => {
    console.log('[wecom] WebSocket connected, authenticating...');
    ws.send(buildSubscribe());
  });

  ws.on('message', (data) => {
    try {
      const frame = JSON.parse(data.toString());
      const cmd = frame.cmd;

      // Handle authentication response
      if (cmd === 'aibot_subscribe') {
        if (frame.body?.code === 0 || frame.body?.status === 'ok') {
          authenticated = true;
          reconnectDelay = config.ws?.reconnect_initial_delay || 1000;
          console.log('[wecom] Authenticated successfully');
          startHeartbeat();
        } else {
          console.error(`[wecom] Authentication failed: ${JSON.stringify(frame.body)}`);
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
          console.error(`[wecom] Callback processing error: ${err.message}`);
        });
        return;
      }

      // Handle send/respond acknowledgements
      if (cmd === 'aibot_respond_msg' || cmd === 'aibot_send_msg') {
        if (frame.body?.code && frame.body.code !== 0) {
          console.error(`[wecom] Send error (${cmd}): ${JSON.stringify(frame.body)}`);
        }
        return;
      }

      // Log unknown frames
      console.log(`[wecom] Unknown frame: ${cmd}`);
    } catch (err) {
      console.error(`[wecom] Failed to parse message: ${err.message}`);
    }
  });

  ws.on('close', (code, reason) => {
    authenticated = false;
    stopHeartbeat();
    const reasonStr = reason?.toString() || 'unknown';
    console.log(`[wecom] WebSocket closed: ${code} ${reasonStr}`);
    scheduleReconnect();
  });

  ws.on('error', (err) => {
    // Suppress expected close errors
    if (err.message?.includes('WebSocket was closed') || isShuttingDown) return;
    console.error(`[wecom] WebSocket error: ${err.message}`);
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

  console.log(`[wecom] Reconnecting in ${Math.round(actualDelay / 1000)}s...`);
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
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        handleInternalRequest(req.url, data, res);
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
  });

  internalServer.listen(port, '127.0.0.1', () => {
    console.log(`[wecom] Internal API on 127.0.0.1:${port}`);
  });
}

function handleInternalRequest(url, data, res) {
  if (url === '/internal/send') {
    const { target, msgId, content } = data;
    if (!target || !content) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing target or content' }));
      return;
    }

    const ok = sendMessage(target, msgId, content);
    res.writeHead(ok ? 200 : 500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok }));

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

console.log(`[wecom] Bot ID: ${creds.bot_id.substring(0, 8)}...`);

// ============================================================
// Graceful shutdown
// ============================================================
async function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log('[wecom] Shutting down...');

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
      console.log('[wecom] Internal server closed');
    });
  }

  // Force exit after timeout
  setTimeout(() => {
    console.log('[wecom] Force exit after timeout');
    process.exit(0);
  }, 5000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

process.on('uncaughtException', (err) => {
  console.error(`[wecom] Uncaught exception: ${err.message}`);
  console.error(err.stack);
});

process.on('unhandledRejection', (reason) => {
  console.error(`[wecom] Unhandled rejection:`, reason);
});
