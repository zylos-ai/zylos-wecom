#!/usr/bin/env node
/**
 * zylos-wecom - WeCom Bot Service
 *
 * Express webhook server that receives encrypted XML events from WeCom,
 * decrypts them, processes messages, and forwards to C4 bridge.
 */

import dotenv from 'dotenv';
import express from 'express';
import crypto from 'crypto';
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

// Load .env from ~/zylos/.env (absolute path, not cwd-dependent)
dotenv.config({ path: path.join(process.env.HOME, 'zylos/.env') });

import { getConfig, watchConfig, saveConfig, DATA_DIR, getCredentials, stopWatching } from './lib/config.js';
import { verifySignature, decrypt, encrypt, buildEncryptedReply } from './lib/crypto.js';
import { sendTextMessage } from './lib/message.js';
import { getUserInfo } from './lib/contact.js';

// C4 receive interface path
const C4_RECEIVE = path.join(process.env.HOME, 'zylos/.claude/skills/comm-bridge/scripts/c4-receive.js');

// Server instance for graceful shutdown
let webhookServer = null;
let isShuttingDown = false;

// Initialize
let config = getConfig();
const INTERNAL_SECRET = crypto.randomUUID();
// Persist token to file so send.js (spawned by C4 in a separate process tree) can read it
const TOKEN_FILE = path.join(DATA_DIR, '.internal-token');
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(TOKEN_FILE, INTERNAL_SECRET, { mode: 0o600 });
} catch (err) {
  console.error(`[wecom] Failed to write internal token file: ${err.message}`);
}
console.log(`[wecom] Starting...`);
console.log(`[wecom] Data directory: ${DATA_DIR}`);

// Ensure directories exist
const LOGS_DIR = path.join(DATA_DIR, 'logs');
const MEDIA_DIR = path.join(DATA_DIR, 'media');
fs.mkdirSync(LOGS_DIR, { recursive: true });
fs.mkdirSync(MEDIA_DIR, { recursive: true });

// State files
const USER_CACHE_PATH = path.join(DATA_DIR, 'user-cache.json');

// ============================================================
// Message deduplication
// ============================================================
const DEDUP_TTL = 5 * 60 * 1000; // 5 minutes
const processedMessages = new Map();

function isDuplicate(msgId) {
  if (!msgId) return false;
  if (processedMessages.has(msgId)) {
    console.log(`[wecom] Duplicate MsgId ${msgId}, skipping`);
    return true;
  }
  processedMessages.set(msgId, Date.now());
  // Cleanup old entries
  if (processedMessages.size > 200) {
    const now = Date.now();
    for (const [id, ts] of processedMessages) {
      if (now - ts > DEDUP_TTL) processedMessages.delete(id);
    }
  }
  return false;
}

// Periodic cleanup
const dedupCleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [id, ts] of processedMessages) {
    if (now - ts > DEDUP_TTL) processedMessages.delete(id);
  }
}, DEDUP_TTL);

console.log(`[wecom] Config loaded, enabled: ${config.enabled}`);

if (!config.enabled) {
  console.log(`[wecom] Component disabled in config, exiting.`);
  process.exit(0);
}

// Verify required credentials
const creds = getCredentials();
if (!creds.corp_id || !creds.corp_secret) {
  console.error(`[wecom] ERROR: WECOM_CORP_ID and WECOM_CORP_SECRET must be set in ~/zylos/.env`);
  process.exit(1);
}
if (!creds.token || !creds.encoding_aes_key) {
  console.error(`[wecom] ERROR: WECOM_TOKEN and WECOM_ENCODING_AES_KEY must be set in ~/zylos/.env`);
  process.exit(1);
}
if (!creds.agent_id) {
  console.warn(`[wecom] WARNING: WECOM_AGENT_ID not set, some features may not work.`);
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
// User name cache with TTL
// ============================================================
const SENDER_NAME_TTL = 10 * 60 * 1000; // 10 minutes
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
  // Deduplicate
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
// Helper: resolve user name
// ============================================================
async function resolveUserName(userId) {
  if (!userId) return 'unknown';

  const now = Date.now();
  const cached = userCacheMemory.get(userId);
  if (cached && now < cached.expireAt) {
    return cached.name;
  }

  try {
    const result = await getUserInfo(userId);
    if (result.success && result.user?.name) {
      userCacheMemory.set(userId, { name: result.user.name, expireAt: now + SENDER_NAME_TTL });
      _userCacheDirty = true;
      return result.user.name;
    }
  } catch (err) {
    console.log(`[wecom] Failed to resolve user name for ${userId}: ${err.message}`);
  }

  // Fallback: use userId as name
  userCacheMemory.set(userId, { name: userId, expireAt: now + SENDER_NAME_TTL });
  return userId;
}

// ============================================================
// Helper: escape XML special characters
// ============================================================
function escapeXml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ============================================================
// Helper: parse XML (simple regex-based, no heavy dependency)
// ============================================================
function parseXmlValue(xml, tag) {
  // Try CDATA first
  const cdataRegex = new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>`);
  const cdataMatch = xml.match(cdataRegex);
  if (cdataMatch) return cdataMatch[1];

  // Try plain value
  const plainRegex = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`);
  const plainMatch = xml.match(plainRegex);
  if (plainMatch) return plainMatch[1].trim();

  return '';
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
  // Owner always passes
  if (isOwner(userId)) return true;

  const policy = config.dmPolicy || 'owner';

  switch (policy) {
    case 'open':
      return true;
    case 'owner':
      return false; // only owner passes (checked above)
    case 'allowlist':
      return (config.dmAllowFrom || []).some(id => String(id) === String(userId));
    default:
      return false;
  }
}

function checkGroupPermission(chatId, userId) {
  const policy = config.groupPolicy || 'allowlist';

  // Owner always bypasses
  if (isOwner(userId)) return true;

  switch (policy) {
    case 'disabled':
      return false;
    case 'open':
      return true;
    case 'allowlist': {
      const groupConfig = config.groups?.[chatId];
      if (!groupConfig) return false;
      // Per-group allowFrom check
      if (groupConfig.allowFrom && groupConfig.allowFrom.length > 0) {
        if (groupConfig.allowFrom.includes('*')) return true;
        return groupConfig.allowFrom.some(id => String(id) === String(userId));
      }
      return true;
    }
    default:
      return false;
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
// Process incoming message
// ============================================================
async function processMessage(msgXml) {
  const msgType = parseXmlValue(msgXml, 'MsgType');
  const fromUser = parseXmlValue(msgXml, 'FromUserName');
  const toUser = parseXmlValue(msgXml, 'ToUserName');
  const msgId = parseXmlValue(msgXml, 'MsgId');
  const agentId = parseXmlValue(msgXml, 'AgentID');
  const createTime = parseXmlValue(msgXml, 'CreateTime');

  // Self-message loop prevention: check if sender is the bot's corp/agent
  if (!fromUser || String(fromUser) === String(creds.corp_id)) {
    console.log(`[wecom] Ignoring self/system message`);
    return;
  }

  // Deduplication
  if (isDuplicate(msgId)) return;

  // Resolve sender name
  const senderName = await resolveUserName(fromUser);

  // Determine if this is a DM or group message
  // WeCom group messages have ChatId in the XML
  const chatId = parseXmlValue(msgXml, 'ChatId');
  const isGroup = !!chatId;

  // Permission check
  if (isGroup) {
    if (!checkGroupPermission(chatId, fromUser)) {
      console.log(`[wecom] Group message from ${senderName} in ${chatId} blocked by policy`);
      return;
    }
  } else {
    // Auto-bind owner on first DM
    if (!config.owner?.bound) {
      tryBindOwner(fromUser, senderName);
    }

    if (!checkDmPermission(fromUser)) {
      console.log(`[wecom] DM from ${senderName} (${fromUser}) blocked by policy`);
      return;
    }
  }

  // Extract message content based on type
  let textContent = '';
  let mediaInfo = '';

  switch (msgType) {
    case 'text': {
      textContent = parseXmlValue(msgXml, 'Content');
      break;
    }
    case 'image': {
      const picUrl = parseXmlValue(msgXml, 'PicUrl');
      const mediaId = parseXmlValue(msgXml, 'MediaId');
      // Download the image
      try {
        const { downloadMedia } = await import('./lib/message.js');
        const safeMsgId = String(msgId).replace(/[^a-zA-Z0-9_-]/g, '_');
        const savePath = path.join(MEDIA_DIR, `img_${safeMsgId}.jpg`);
        const dlResult = await downloadMedia(mediaId, savePath);
        if (dlResult.success) {
          mediaInfo = `[image: ${dlResult.path}]`;
          textContent = mediaInfo;
        } else {
          textContent = `[image, media_id: ${mediaId}]`;
        }
      } catch {
        textContent = `[image, media_id: ${parseXmlValue(msgXml, 'MediaId')}]`;
      }
      break;
    }
    case 'voice': {
      const mediaId = parseXmlValue(msgXml, 'MediaId');
      textContent = `[voice, media_id: ${mediaId}]`;
      break;
    }
    case 'video': {
      const mediaId = parseXmlValue(msgXml, 'MediaId');
      textContent = `[video, media_id: ${mediaId}]`;
      break;
    }
    case 'file': {
      const mediaId = parseXmlValue(msgXml, 'MediaId');
      const fileName = parseXmlValue(msgXml, 'FileName');
      textContent = `[file: ${fileName || 'unknown'}, media_id: ${mediaId}]`;
      break;
    }
    case 'location': {
      const lat = parseXmlValue(msgXml, 'Location_X');
      const lon = parseXmlValue(msgXml, 'Location_Y');
      const label = parseXmlValue(msgXml, 'Label');
      textContent = `[location: ${label || ''} (${lat}, ${lon})]`;
      break;
    }
    case 'link': {
      const title = parseXmlValue(msgXml, 'Title');
      const description = parseXmlValue(msgXml, 'Description');
      const url = parseXmlValue(msgXml, 'Url');
      textContent = `[link: ${title || description || url}] ${url}`;
      break;
    }
    case 'event': {
      const event = parseXmlValue(msgXml, 'Event');
      console.log(`[wecom] Event received: ${event}`);
      // Handle subscribe event -- could auto-bind owner
      if (event === 'subscribe' && !config.owner?.bound) {
        tryBindOwner(fromUser, senderName);
      }
      return; // Don't forward events to C4
    }
    default: {
      textContent = `[${msgType} message]`;
      break;
    }
  }

  if (!textContent) return;

  // Record to history
  recordHistoryEntry(isGroup ? chatId : fromUser, {
    msgId,
    userId: fromUser,
    userName: senderName,
    text: textContent,
    timestamp: new Date(parseInt(createTime, 10) * 1000).toISOString()
  });

  // Build C4 formatted message
  let formattedMessage;

  if (isGroup) {
    const groupName = config.groups?.[chatId]?.name || chatId;
    formattedMessage = `[WeCom GROUP:${escapeXml(groupName)}] ${escapeXml(senderName)} said: ${textContent}`;

    // Build context
    const context = getContextMessages(chatId, msgId);
    if (context.length > 0) {
      const contextLines = context.map(m =>
        `${escapeXml(m.userName)}: ${m.text}`
      ).join('\n');
      formattedMessage = `[WeCom GROUP:${escapeXml(groupName)}] ${escapeXml(senderName)} said: ${textContent}\n\n--- recent context ---\n${contextLines}`;
    }

    const endpoint = `${chatId}|type:group|msg:${msgId}`;
    forwardToC4(formattedMessage, endpoint);
  } else {
    formattedMessage = `[WeCom DM] ${escapeXml(senderName)} said: ${textContent}`;

    // Build context for DM
    const context = getContextMessages(fromUser, msgId);
    if (context.length > 0) {
      const contextLines = context.map(m =>
        `${escapeXml(m.userName)}: ${m.text}`
      ).join('\n');
      formattedMessage = `[WeCom DM] ${escapeXml(senderName)} said: ${textContent}\n\n--- recent context ---\n${contextLines}`;
    }

    const endpoint = `${fromUser}|type:p2p|msg:${msgId}`;
    forwardToC4(formattedMessage, endpoint);
  }

  console.log(`[wecom] ${isGroup ? 'Group' : 'DM'} from ${senderName}: ${textContent.slice(0, 100)}`);
}

// ============================================================
// Express webhook server
// ============================================================
const app = express();

// Raw body parser for XML
app.use('/webhook', express.raw({ type: '*/*', limit: '5mb' }));

/**
 * GET /webhook - URL Verification
 * WeCom sends: msg_signature, timestamp, nonce, echostr
 * We must decrypt echostr and return the plaintext.
 */
app.get('/webhook', (req, res) => {
  const { msg_signature, timestamp, nonce, echostr } = req.query;

  if (!msg_signature || !timestamp || !nonce || !echostr) {
    console.log('[wecom] Webhook verification: missing params');
    return res.status(400).send('Missing parameters');
  }

  console.log(`[wecom] Webhook verification request received`);

  try {
    // Verify signature
    if (!verifySignature(msg_signature, creds.token, timestamp, nonce, echostr)) {
      console.error('[wecom] Webhook verification: signature mismatch');
      return res.status(403).send('Signature verification failed');
    }

    // Decrypt echostr to get the plain echostr
    const { message: plainEchostr } = decrypt(echostr, creds.encoding_aes_key, creds.corp_id);

    console.log(`[wecom] Webhook verification successful`);
    // Return the decrypted echostr as plain text
    res.status(200).send(plainEchostr);
  } catch (err) {
    console.error(`[wecom] Webhook verification error: ${err.message}`);
    res.status(500).send('Verification error');
  }
});

/**
 * POST /webhook - Receive Messages
 * WeCom sends encrypted XML with msg_signature, timestamp, nonce query params.
 */
app.post('/webhook', async (req, res) => {
  const { msg_signature, timestamp, nonce } = req.query;

  if (!msg_signature || !timestamp || !nonce) {
    return res.status(400).send('Missing parameters');
  }

  // Respond immediately with success to avoid WeCom retries
  res.status(200).send('success');

  try {
    const bodyStr = req.body.toString('utf8');

    // Extract Encrypt field from the outer XML
    const encryptedMsg = parseXmlValue(bodyStr, 'Encrypt');
    if (!encryptedMsg) {
      console.error('[wecom] No Encrypt field in webhook body');
      return;
    }

    // Verify signature
    if (!verifySignature(msg_signature, creds.token, timestamp, nonce, encryptedMsg)) {
      console.error('[wecom] Message signature verification failed');
      return;
    }

    // Decrypt the message
    const { message: decryptedXml } = decrypt(encryptedMsg, creds.encoding_aes_key, creds.corp_id);

    // Process the decrypted XML message
    await processMessage(decryptedXml);
  } catch (err) {
    console.error(`[wecom] Webhook processing error: ${err.message}`);
  }
});

// ============================================================
// Internal endpoints (bound to 127.0.0.1)
// ============================================================
const internalApp = express();
internalApp.use(express.json({ limit: '1mb' }));

// Auth middleware for internal endpoints
internalApp.use((req, res, next) => {
  const token = req.headers['x-internal-token'];
  if (token !== INTERNAL_SECRET) {
    return res.status(403).json({ error: 'Invalid internal token' });
  }
  next();
});

/**
 * POST /internal/record-outgoing
 * Record bot's outgoing message into in-memory history.
 */
internalApp.post('/internal/record-outgoing', (req, res) => {
  const { chatId, text } = req.body;
  if (!chatId || !text) {
    return res.status(400).json({ error: 'Missing chatId or text' });
  }

  recordHistoryEntry(String(chatId), {
    msgId: `out_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    userId: 'bot',
    userName: 'bot',
    text: String(text).slice(0, 4000),
    timestamp: new Date().toISOString()
  });

  res.json({ ok: true });
});

// ============================================================
// Startup
// ============================================================
const port = config.webhook_port || 3459;
const internalPort = port + 1000; // e.g., 4459

webhookServer = app.listen(port, () => {
  console.log(`[wecom] Webhook server listening on port ${port}`);
  console.log(`[wecom] Webhook URL: http://0.0.0.0:${port}/webhook`);
});

const internalServer = internalApp.listen(internalPort, '127.0.0.1', () => {
  console.log(`[wecom] Internal API on 127.0.0.1:${internalPort}`);
});

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
  clearInterval(userCachePersistInterval);

  // Persist user cache
  persistUserCache();

  // Close servers
  if (webhookServer) {
    webhookServer.close(() => {
      console.log('[wecom] Webhook server closed');
    });
  }
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
  // Don't crash on uncaught exceptions in production
});

process.on('unhandledRejection', (reason) => {
  console.error(`[wecom] Unhandled rejection:`, reason);
});
