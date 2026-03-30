import fs from 'fs';
import os from 'os';
import path from 'path';

const ZYLOS_CONFIG_PATH = path.join(os.homedir(), 'zylos', 'components', 'wecom', 'wecom-mcp-config.json');
const OPENCLAW_CONFIG_PATH = path.join(os.homedir(), '.openclaw', 'wecomConfig', 'config.json');

export function getDocConfigPaths() {
  return {
    primary: ZYLOS_CONFIG_PATH,
    fallback: OPENCLAW_CONFIG_PATH
  };
}

export function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

export function extractDocConfig(payload) {
  const doc = payload?.mcpConfig?.doc;
  if (!doc || typeof doc !== 'object') return null;

  const url = typeof doc.url === 'string' ? doc.url.trim() : '';
  if (!url) return null;

  return {
    type: typeof doc.type === 'string' && doc.type.trim() ? doc.type.trim() : 'streamable-http',
    url,
    authPageUrl: typeof doc.authPageUrl === 'string' ? doc.authPageUrl.trim() : '',
    botId: typeof doc.botId === 'string' ? doc.botId.trim() : '',
    isAuthed: typeof doc.isAuthed === 'boolean' ? doc.isAuthed : undefined
  };
}

export function resolveDocConfig() {
  const { primary, fallback } = getDocConfigPaths();

  const primaryConfig = extractDocConfig(readJson(primary));
  if (primaryConfig) return { ...primaryConfig, source: primary };

  const fallbackConfig = extractDocConfig(readJson(fallback));
  if (fallbackConfig) return { ...fallbackConfig, source: fallback };

  return null;
}

export function getInternalToken() {
  try {
    return fs.readFileSync(path.join(os.homedir(), 'zylos', 'components', 'wecom', '.internal-token'), 'utf8').trim();
  } catch {
    return '';
  }
}

export async function refreshDocConfigFromRuntime(runtimeConfig) {
  const token = getInternalToken();
  if (!token) return null;

  const port = runtimeConfig.internal_port || 4459;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), (runtimeConfig.doc?.fetch_timeout_ms || 5000) + 2000);

  try {
    const res = await fetch(`http://127.0.0.1:${port}/internal/refresh-doc-mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Token': token
      },
      body: '{}',
      signal: controller.signal
    });

    if (!res.ok) return null;
    const payload = await res.json();
    if (!payload?.ok || !payload?.config?.url) return null;

    return {
      type: payload.config.type || 'streamable-http',
      url: payload.config.url,
      authPageUrl: payload.config.authPageUrl || '',
      botId: payload.config.botId || '',
      isAuthed: typeof payload.config.isAuthed === 'boolean' ? payload.config.isAuthed : undefined,
      source: 'runtime-refresh'
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
