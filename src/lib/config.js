/**
 * Configuration loader for zylos-wecom
 *
 * Loads config from ~/zylos/components/wecom/config.json
 * Secrets from ~/zylos/.env (WECOM_BOT_ID, WECOM_BOT_SECRET)
 */

import fs from 'fs';
import path from 'path';
import { t } from './i18n/cli-messages.js';
import { resolveRuntimeLocale } from './i18n/runtime.js';

const HOME = process.env.HOME;
export const DATA_DIR = path.join(HOME, 'zylos/components/wecom');
export const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

// Default configuration
export const DEFAULT_CONFIG = {
  enabled: true,
  internal_port: 4459,
  // Owner (primary partner) - auto-bound on first private message
  owner: {
    bound: false,
    user_id: '',
    name: ''
  },
  // DM policy: 'open' (anyone can DM), 'allowlist' (only dmAllowFrom), 'owner' (owner only)
  dmPolicy: 'owner',
  // DM allowlist -- user_id values (used when dmPolicy = 'allowlist')
  dmAllowFrom: [],
  // Group policy: 'open' (all groups), 'allowlist' (only configured groups), 'disabled' (no groups)
  groupPolicy: 'allowlist',
  // Per-group configuration map
  // Format: { "chatId": { name, mode, allowFrom } }
  // mode: "mention" (respond to @mentions) or "smart" (receive all messages)
  // Legacy config field "requireMention" is still supported for backward compatibility.
  groups: {},
  // Message settings
  message: {
    context_messages: 10,
    locale: 'zh-CN',
    enable_thinking_placeholder: true,
    welcome_text: '',  // legacy fallback; empty = no auto-reply; non-empty = auto-reply
    welcome_texts: {}  // locale-aware welcome messages, keyed by locale (e.g. zh-CN, en-US)
  },
  // Doc MCP bootstrap settings
  doc: {
    fetch_timeout_ms: 5000,
    persist_openclaw_compat: true
  },
  // WebSocket settings
  ws: {
    url: 'wss://openws.work.weixin.qq.com',
    heartbeat_interval: 30000,
    reconnect_initial_delay: 1000,
    reconnect_max_delay: 30000
  }
};

let config = null;
let configWatcher = null;
let configReloadTimer = null;

function configLocale(candidateConfig = config) {
  return resolveRuntimeLocale(candidateConfig);
}

/**
 * Load configuration from file
 */
export function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const content = fs.readFileSync(CONFIG_PATH, 'utf8');
      const parsed = JSON.parse(content);
      config = { ...DEFAULT_CONFIG, ...parsed };
      // Ensure nested objects are merged
      config.owner = { ...DEFAULT_CONFIG.owner, ...parsed.owner };
      config.message = { ...DEFAULT_CONFIG.message, ...parsed.message };
      config.doc = { ...DEFAULT_CONFIG.doc, ...parsed.doc };
      config.ws = { ...DEFAULT_CONFIG.ws, ...parsed.ws };
    } else {
      console.warn(`[wecom] ${t(configLocale(DEFAULT_CONFIG), 'config_file_missing', { path: CONFIG_PATH })}`);
      config = { ...DEFAULT_CONFIG };
    }
  } catch (err) {
    console.error(`[wecom] ${t(configLocale(DEFAULT_CONFIG), 'config_load_failed', { message: err.message })}`);
    config = { ...DEFAULT_CONFIG };
  }
  return config;
}

/**
 * Get current configuration
 */
export function getConfig() {
  if (!config) {
    loadConfig();
  }
  return config;
}

/**
 * Save configuration to file (atomic write: tmp + rename)
 */
export function saveConfig(newConfig) {
  const tmpPath = CONFIG_PATH + '.tmp';
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(newConfig, null, 2));
    fs.renameSync(tmpPath, CONFIG_PATH);
    config = newConfig;
    return true;
  } catch (err) {
    console.error(`[wecom] ${t(configLocale(newConfig || DEFAULT_CONFIG), 'config_save_failed', { message: err.message })}`);
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {}
    return false;
  }
}

/**
 * Watch config file for changes (handles both 'change' and 'rename' events)
 */
export function watchConfig(onChange) {
  if (configWatcher) {
    configWatcher.close();
  }
  if (configReloadTimer) {
    clearTimeout(configReloadTimer);
    configReloadTimer = null;
  }

  const configDir = path.dirname(CONFIG_PATH);
  const configBase = path.basename(CONFIG_PATH);

  const scheduleReload = () => {
    if (configReloadTimer) clearTimeout(configReloadTimer);
    configReloadTimer = setTimeout(() => {
      configReloadTimer = null;
      if (!fs.existsSync(CONFIG_PATH)) {
        console.warn(`[wecom] ${t(configLocale(), 'config_watch_missing')}`);
        return;
      }
      console.log(`[wecom] ${t(configLocale(), 'config_watch_reloading')}`);
      loadConfig();
      if (onChange) {
        onChange(config);
      }
    }, 100);
  };

  if (fs.existsSync(configDir)) {
    configWatcher = fs.watch(configDir, (eventType, filename) => {
      if (filename && String(filename) === configBase) {
        scheduleReload();
      }
    });
    configWatcher.on('error', (err) => {
      console.warn(`[wecom] ${t(configLocale(), 'config_watch_error', { message: err.message })}`);
      if (configReloadTimer) {
        clearTimeout(configReloadTimer);
        configReloadTimer = null;
      }
      try {
        configWatcher.close();
      } catch {}
      configWatcher = null;
    });
  }
}

/**
 * Stop watching config file
 */
export function stopWatching() {
  if (configReloadTimer) {
    clearTimeout(configReloadTimer);
    configReloadTimer = null;
  }
  if (configWatcher) {
    configWatcher.close();
    configWatcher = null;
  }
}

/**
 * Get credentials from environment
 */
export function getCredentials() {
  return {
    bot_id: process.env.WECOM_BOT_ID || '',
    secret: process.env.WECOM_BOT_SECRET || ''
  };
}
