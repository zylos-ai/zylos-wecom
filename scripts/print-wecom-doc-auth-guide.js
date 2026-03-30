#!/usr/bin/env node

import fs from 'fs';
import os from 'os';
import path from 'path';

import { getConfig } from '../src/lib/config.js';
import {
  renderDocAuthGuide,
  resolveDocAuthGuideLocale
} from '../src/lib/i18n/doc-auth-guide.js';
import { parseLocaleArg } from '../src/lib/i18n/locale.js';

const ZYLOS_CONFIG_PATH = path.join(os.homedir(), 'zylos', 'components', 'wecom', 'wecom-mcp-config.json');
const OPENCLAW_CONFIG_PATH = path.join(os.homedir(), '.openclaw', 'wecomConfig', 'config.json');

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function extractDocConfig(payload) {
  const doc = payload?.mcpConfig?.doc;
  if (!doc || typeof doc !== 'object') return null;
  const url = typeof doc.url === 'string' ? doc.url.trim() : '';
  const type = typeof doc.type === 'string' && doc.type.trim() ? doc.type.trim() : 'streamable-http';
  const authPageUrl = typeof doc.authPageUrl === 'string' ? doc.authPageUrl.trim() : '';
  const botId = typeof doc.botId === 'string' ? doc.botId.trim() : '';
  const isAuthed = typeof doc.isAuthed === 'boolean' ? doc.isAuthed : undefined;
  return { url, type, authPageUrl, botId, isAuthed };
}

function resolveDocConfig() {
  const primaryPayload = readJson(ZYLOS_CONFIG_PATH);
  const primary = extractDocConfig(primaryPayload);
  if (primary) return { ...primary, source: ZYLOS_CONFIG_PATH };

  const fallbackPayload = readJson(OPENCLAW_CONFIG_PATH);
  const fallback = extractDocConfig(fallbackPayload);
  if (fallback) return { ...fallback, source: OPENCLAW_CONFIG_PATH };

  return null;
}

function getInternalToken() {
  try {
    return fs.readFileSync(path.join(os.homedir(), 'zylos', 'components', 'wecom', '.internal-token'), 'utf8').trim();
  } catch {
    return '';
  }
}

const runtimeConfig = getConfig();
const locale = resolveDocAuthGuideLocale({
  cliLocale: parseLocaleArg(process.argv.slice(2)),
  configLocale: runtimeConfig?.message?.locale,
  envLocale: process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG
});

async function refreshDocConfigFromRuntime() {
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
      url: payload.config.url,
      type: payload.config.type || 'streamable-http',
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

const docConfig = await refreshDocConfigFromRuntime() || resolveDocConfig();

console.log(renderDocAuthGuide({
  locale,
  docConfig,
  checkedPaths: [ZYLOS_CONFIG_PATH, OPENCLAW_CONFIG_PATH]
}));
