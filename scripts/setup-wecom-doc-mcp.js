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

const docConfig = resolveDocConfig();
if (!docConfig) {
  console.error(t(locale, 'setup_no_config'));
  console.error(t(locale, 'setup_checked', { path: ZYLOS_CONFIG_PATH }));
  console.error(t(locale, 'setup_checked', { path: OPENCLAW_CONFIG_PATH }));
  process.exit(1);
}

const probe = runMcporter(['list', 'wecom-doc', '--output', 'json']);
if (probe.status === 0) {
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

if (probe.error && probe.error.code === 'ENOENT') {
  console.error(t(locale, 'setup_mcporter_missing'));
  process.exit(1);
}

const add = runMcporter(['config', 'add', 'wecom-doc', '--type', docConfig.type, '--url', docConfig.url]);
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
