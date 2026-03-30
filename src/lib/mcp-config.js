import fs from 'fs';
import os from 'os';
import path from 'path';

import { DATA_DIR, getCredentials } from './config.js';

const DOC_BIZ_TYPE = 'doc';
const DEFAULT_DOC_MCP_TYPE = 'streamable-http';
const DEFAULT_FETCH_TIMEOUT_MS = 5000;
const writeQueues = new Map();
const AUTH_PAGE_URL_KEYS = [
  'auth_url',
  'auth_page_url',
  'authorization_url',
  'authorization_page_url',
  'authorizationPageUrl',
  'authorizationPage'
];
const BOT_ID_KEYS = [
  'str_aibotid',
  'aibotid',
  'aibot_id',
  'bot_id'
];
const AUTHORIZATION_PAGE_BASE_URL = 'https://work.weixin.qq.com/ai/aiHelper/authorizationPage';

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function resolveWecomDocMcpConfigPath() {
  return path.join(DATA_DIR, 'wecom-mcp-config.json');
}

export function resolveOpenClawCompatPath() {
  return path.join(os.homedir(), '.openclaw', 'wecomConfig', 'config.json');
}

function readResponseField(body, key) {
  if (!isRecord(body)) return undefined;
  const value = body[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readResponseBoolean(body, key) {
  if (!isRecord(body)) return undefined;
  const value = body[key];
  return typeof value === 'boolean' ? value : undefined;
}

function readFirstResponseField(body, keys) {
  for (const key of keys) {
    const value = readResponseField(body, key);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function readConfiguredBotId() {
  const botId = getCredentials()?.bot_id;
  return typeof botId === 'string' && botId.trim() ? botId.trim() : undefined;
}

function validateHttpUrl(value, label) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`WeCom doc MCP config response contains an invalid ${label}`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`WeCom doc MCP config response contains an unsupported ${label} protocol`);
  }
  return parsed.toString();
}

function buildAuthorizationPageUrl(botId) {
  if (!botId) return undefined;
  const query = new URLSearchParams({
    str_aibotid: botId,
    type: '1',
    from: 'chat',
    forceInnerBrowser: '1'
  });
  return validateHttpUrl(`${AUTHORIZATION_PAGE_BASE_URL}?${query.toString()}`, 'authPageUrl');
}

async function serializeWrite(filePath, action) {
  const previous = writeQueues.get(filePath) || Promise.resolve();
  const next = previous.catch(() => undefined).then(action);
  writeQueues.set(filePath, next);
  try {
    await next;
  } finally {
    if (writeQueues.get(filePath) === next) {
      writeQueues.delete(filePath);
    }
  }
}

async function readPersistedConfig(filePath) {
  try {
    const raw = await fs.promises.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {};
    }
    return {};
  }
}

async function writePersistedConfig(filePath, data) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const payload = `${JSON.stringify(data, null, 2)}\n`;
  await fs.promises.writeFile(tempPath, payload, 'utf8');
  await fs.promises.rename(tempPath, filePath);
}

function buildPersistedDocConfig(config) {
  const docConfig = {
    type: config.type || DEFAULT_DOC_MCP_TYPE,
    url: config.url
  };

  if (config.authPageUrl) {
    docConfig.authPageUrl = config.authPageUrl;
  }
  if (config.botId) {
    docConfig.botId = config.botId;
  }

  return docConfig;
}

async function saveConfigFile(filePath, accountId, config) {
  const docConfig = buildPersistedDocConfig(config);

  await serializeWrite(filePath, async () => {
    const current = await readPersistedConfig(filePath);
    const currentAccounts = isRecord(current.accounts) ? current.accounts : {};
    const existingAccount = isRecord(currentAccounts[accountId]) ? currentAccounts[accountId] : {};
    const existingAccountMcpConfig = isRecord(existingAccount.mcpConfig) ? existingAccount.mcpConfig : {};

    current.updatedAt = new Date(config.fetchedAt).toISOString();
    current.mcpConfig = {
      ...(isRecord(current.mcpConfig) ? current.mcpConfig : {}),
      doc: {
        ...docConfig,
        isAuthed: config.isAuthed
      }
    };
    current.accounts = {
      ...currentAccounts,
      [accountId]: {
        ...existingAccount,
        fetchedAt: new Date(config.fetchedAt).toISOString(),
        isAuthed: config.isAuthed,
        mcpConfig: {
          ...existingAccountMcpConfig,
          doc: docConfig
        }
      }
    };

    await writePersistedConfig(filePath, current);
  });
}

export async function saveWecomDocMcpConfig({ accountId = 'default', config, persistOpenClawCompat = true }) {
  await saveConfigFile(resolveWecomDocMcpConfigPath(), accountId, config);
  if (persistOpenClawCompat) {
    await saveConfigFile(resolveOpenClawCompatPath(), accountId, config);
  }
}

export async function fetchWecomDocMcpConfig({ request, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS }) {
  const response = await request('aibot_get_mcp_config', { biz_type: DOC_BIZ_TYPE }, { timeoutMs });

  if (typeof response?.errcode === 'number' && response.errcode !== 0) {
    throw new Error(`WeCom doc MCP config request failed: ${response.errcode} ${response.errmsg || ''}`.trim());
  }
  if (typeof response?.body?.code === 'number' && response.body.code !== 0) {
    throw new Error(`WeCom doc MCP config request failed: ${response.body.code} ${response.body.msg || ''}`.trim());
  }

  const url = readResponseField(response?.body, 'url');
  if (!url) {
    throw new Error('WeCom doc MCP config response missing url');
  }

  const botId = readFirstResponseField(response?.body, BOT_ID_KEYS) || readConfiguredBotId();
  const authPageUrl =
    readFirstResponseField(response?.body, AUTH_PAGE_URL_KEYS) || buildAuthorizationPageUrl(botId);

  return {
    bizType: DOC_BIZ_TYPE,
    url: validateHttpUrl(url, 'url'),
    type: readResponseField(response?.body, 'type') || DEFAULT_DOC_MCP_TYPE,
    authPageUrl: authPageUrl ? validateHttpUrl(authPageUrl, 'authPageUrl') : undefined,
    botId,
    isAuthed: readResponseBoolean(response?.body, 'is_authed'),
    fetchedAt: Date.now()
  };
}

export async function fetchAndSaveWecomDocMcpConfig({
  accountId = 'default',
  request,
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
  persistOpenClawCompat = true,
  log = () => {},
  error = () => {}
}) {
  try {
    const config = await fetchWecomDocMcpConfig({ request, timeoutMs });
    await saveWecomDocMcpConfig({ accountId, config, persistOpenClawCompat });
    log(`[wecom] doc MCP config saved for account ${accountId} at ${resolveWecomDocMcpConfigPath()}`);
    if (persistOpenClawCompat) {
      log(`[wecom] doc MCP config mirrored to ${resolveOpenClawCompatPath()}`);
    }
    if (config.isAuthed === false) {
      log('[wecom] doc MCP config fetched with isAuthed=false; treat it as the latest auth snapshot and keep retrying MCP calls once the user finishes authorization');
    }
    return config;
  } catch (err) {
    error(`[wecom] failed to fetch/save doc MCP config for account ${accountId}: ${err.message}`);
    return null;
  }
}
