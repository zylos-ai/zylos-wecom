#!/usr/bin/env node

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

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
  console.error('No WeCom doc MCP config found.');
  console.error(`Checked: ${ZYLOS_CONFIG_PATH}`);
  console.error(`Checked: ${OPENCLAW_CONFIG_PATH}`);
  process.exit(1);
}

const probe = runMcporter(['list', 'wecom-doc', '--output', 'json']);
if (probe.status === 0) {
  console.log('wecom-doc is already configured in mcporter.');
  if (docConfig.isAuthed === false) {
    console.log('WARNING: doc MCP is configured, but WeCom document authorization is not complete yet.');
    if (docConfig.authPageUrl) {
      console.log(`authorization_page: ${docConfig.authPageUrl}`);
    } else if (docConfig.botId) {
      console.log(`bot_id: ${docConfig.botId}`);
    }
  }
  process.stdout.write(probe.stdout || '');
  process.exit(0);
}

if (probe.error && probe.error.code === 'ENOENT') {
  console.error('mcporter is not installed or not in PATH.');
  process.exit(1);
}

const add = runMcporter(['config', 'add', 'wecom-doc', '--type', docConfig.type, '--url', docConfig.url]);
if (add.status !== 0) {
  process.stderr.write(add.stderr || '');
  process.exit(add.status || 1);
}

console.log(`Configured wecom-doc from ${docConfig.source}`);
if (docConfig.isAuthed === false) {
  console.log('WARNING: doc MCP config exists, but user authorization is still required before doc calls can succeed.');
  if (docConfig.authPageUrl) {
    console.log(`authorization_page: ${docConfig.authPageUrl}`);
  } else if (docConfig.botId) {
    console.log(`bot_id: ${docConfig.botId}`);
  }
}
const verify = runMcporter(['list', 'wecom-doc', '--output', 'json']);
if (verify.stdout) process.stdout.write(verify.stdout);
if (verify.status !== 0) {
  process.stderr.write(verify.stderr || '');
  process.exit(verify.status || 1);
}
