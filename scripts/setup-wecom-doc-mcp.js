#!/usr/bin/env node

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { getConfig } from '../src/lib/config.js';
import { t } from '../src/lib/i18n/cli-messages.js';
import { parseLocaleArg, resolveLocale } from '../src/lib/i18n/locale.js';

const ZYLOS_CONFIG_PATH = path.join(os.homedir(), 'zylos', 'components', 'wecom', 'wecom-mcp-config.json');
const OPENCLAW_CONFIG_PATH = path.join(os.homedir(), '.openclaw', 'wecomConfig', 'config.json');
const runtimeConfig = getConfig();
const locale = resolveLocale({
  cliLocale: parseLocaleArg(process.argv.slice(2)),
  configLocale: runtimeConfig?.message?.locale,
  envLocale: process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG
});

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function extractDocConfig(payload) {
  const doc = payload?.mcpConfig?.doc;
  if (!doc?.url) return null;
  return {
    type: doc.type || 'streamable-http',
    url: doc.url,
    authPageUrl: doc.authPageUrl || '',
    botId: doc.botId || '',
    isAuthed: typeof doc.isAuthed === 'boolean' ? doc.isAuthed : undefined
  };
}

function resolveDocConfig() {
  const primary = extractDocConfig(readJson(ZYLOS_CONFIG_PATH));
  if (primary) return { ...primary, source: ZYLOS_CONFIG_PATH };

  const fallback = extractDocConfig(readJson(OPENCLAW_CONFIG_PATH));
  if (fallback) return { ...fallback, source: OPENCLAW_CONFIG_PATH };

  return null;
}

function runMcporter(args) {
  return spawnSync('mcporter', args, { stdio: 'pipe', encoding: 'utf8' });
}

function getExistingMcporterServer(name) {
  const result = runMcporter(['config', 'get', name, '--json']);
  if (result.status !== 0) return null;
  try {
    return JSON.parse(result.stdout || '{}');
  } catch {
    return null;
  }
}

function resolveServerUrl(server) {
  return typeof server?.baseUrl === 'string' ? server.baseUrl : '';
}

function resolveServerTransport(server) {
  return typeof server?.transport === 'string' ? server.transport : '';
}

function getInternalToken() {
  try {
    return fs.readFileSync(path.join(os.homedir(), 'zylos', 'components', 'wecom', '.internal-token'), 'utf8').trim();
  } catch {
    return '';
  }
}

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

const docConfig = await refreshDocConfigFromRuntime() || resolveDocConfig();
if (!docConfig) {
  console.error(t(locale, 'setup_no_config'));
  console.error(t(locale, 'setup_checked', { path: ZYLOS_CONFIG_PATH }));
  console.error(t(locale, 'setup_checked', { path: OPENCLAW_CONFIG_PATH }));
  process.exit(1);
}

const probe = runMcporter(['list', 'wecom-doc', '--output', 'json']);
if (probe.status === 0) {
  const existing = getExistingMcporterServer('wecom-doc');
  const currentUrl = resolveServerUrl(existing);
  const currentTransport = resolveServerTransport(existing);
  const needsUpdate = currentUrl !== docConfig.url || currentTransport !== 'http';

  if (!needsUpdate) {
    console.log(t(locale, 'setup_already_configured'));
    if (docConfig.isAuthed === false) {
      console.log(t(locale, 'setup_auth_incomplete_warning'));
      if (docConfig.authPageUrl) {
        console.log(t(locale, 'setup_auth_page', { url: docConfig.authPageUrl }));
      } else if (docConfig.botId) {
        console.log(t(locale, 'setup_bot_id', { botId: docConfig.botId }));
      }
    }
    process.stdout.write(probe.stdout || '');
    process.exit(0);
  }

  const update = runMcporter(['config', 'add', 'wecom-doc', '--url', docConfig.url]);
  if (update.status !== 0) {
    process.stderr.write(update.stderr || '');
    process.exit(update.status || 1);
  }

  console.log(t(locale, 'setup_configured_from', { source: docConfig.source }));
  if (docConfig.isAuthed === false) {
    console.log(t(locale, 'setup_auth_incomplete_warning'));
    if (docConfig.authPageUrl) {
      console.log(t(locale, 'setup_auth_page', { url: docConfig.authPageUrl }));
    } else if (docConfig.botId) {
      console.log(t(locale, 'setup_bot_id', { botId: docConfig.botId }));
    }
  }
  const verifyExisting = runMcporter(['list', 'wecom-doc', '--output', 'json']);
  if (verifyExisting.stdout) process.stdout.write(verifyExisting.stdout);
  if (verifyExisting.status !== 0) {
    process.stderr.write(verifyExisting.stderr || '');
    process.exit(verifyExisting.status || 1);
  }
  process.exit(0);
}

if (probe.error && probe.error.code === 'ENOENT') {
  console.error(t(locale, 'setup_mcporter_missing'));
  process.exit(1);
}

const add = runMcporter(['config', 'add', 'wecom-doc', '--url', docConfig.url]);
if (add.status !== 0) {
  process.stderr.write(add.stderr || '');
  process.exit(add.status || 1);
}

console.log(t(locale, 'setup_configured_from', { source: docConfig.source }));
if (docConfig.isAuthed === false) {
  console.log(t(locale, 'setup_auth_required_warning'));
  if (docConfig.authPageUrl) {
    console.log(t(locale, 'setup_auth_page', { url: docConfig.authPageUrl }));
  } else if (docConfig.botId) {
    console.log(t(locale, 'setup_bot_id', { botId: docConfig.botId }));
  }
}
const verify = runMcporter(['list', 'wecom-doc', '--output', 'json']);
if (verify.stdout) process.stdout.write(verify.stdout);
if (verify.status !== 0) {
  process.stderr.write(verify.stderr || '');
  process.exit(verify.status || 1);
}
