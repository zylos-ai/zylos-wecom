import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  fetchWecomDocMcpConfig,
  resolveWecomDocMcpConfigPath,
  resolveOpenClawCompatPath,
  saveWecomDocMcpConfig
} from './mcp-config.js';

test('saveWecomDocMcpConfig writes primary config file', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-wecom-home-'));
  const previousHome = process.env.HOME;
  process.env.HOME = home;

  try {
    const config = {
      type: 'streamable-http',
      url: 'https://example.test/mcp',
      isAuthed: true,
      fetchedAt: Date.now()
    };

    await saveWecomDocMcpConfig({
      accountId: 'default',
      config,
      persistOpenClawCompat: false
    });

    const payload = JSON.parse(fs.readFileSync(resolveWecomDocMcpConfigPath(), 'utf8'));
    assert.equal(payload.mcpConfig.doc.url, config.url);
    assert.equal(payload.mcpConfig.doc.type, config.type);
    assert.equal(payload.accounts.default.isAuthed, true);
    assert.equal(fs.existsSync(resolveOpenClawCompatPath()), false);
  } finally {
    process.env.HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('saveWecomDocMcpConfig writes compatibility mirror when enabled', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-wecom-home-'));
  const previousHome = process.env.HOME;
  process.env.HOME = home;

  try {
    const config = {
      type: 'streamable-http',
      url: 'https://example.test/mcp-compat',
      isAuthed: false,
      fetchedAt: Date.now()
    };

    await saveWecomDocMcpConfig({
      accountId: 'default',
      config,
      persistOpenClawCompat: true
    });

    const compat = JSON.parse(fs.readFileSync(resolveOpenClawCompatPath(), 'utf8'));
    assert.equal(compat.mcpConfig.doc.url, config.url);
    assert.equal(compat.accounts.default.isAuthed, false);
  } finally {
    process.env.HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('fetchWecomDocMcpConfig preserves auth metadata when provided', async () => {
  const config = await fetchWecomDocMcpConfig({
    request: async () => ({
      body: {
        url: 'https://example.test/mcp',
        type: 'streamable-http',
        is_authed: false,
        authorization_page_url: 'https://work.weixin.qq.com/ai/aiHelper/authorizationPage?str_aibotid=test',
        str_aibotid: 'aib1_test'
      }
    })
  });

  assert.equal(config.url, 'https://example.test/mcp');
  assert.equal(config.type, 'streamable-http');
  assert.equal(config.isAuthed, false);
  assert.equal(
    config.authPageUrl,
    'https://work.weixin.qq.com/ai/aiHelper/authorizationPage?str_aibotid=test'
  );
  assert.equal(config.botId, 'aib1_test');
});

test('fetchWecomDocMcpConfig derives auth metadata from configured bot id when response omits it', async () => {
  const previousBotId = process.env.WECOM_BOT_ID;
  process.env.WECOM_BOT_ID = 'aib9tgHEwLkicK4leYx2rtoFsKO5AJhukyk';

  try {
    const config = await fetchWecomDocMcpConfig({
      request: async () => ({
        body: {
          url: 'https://example.test/mcp',
          type: 'streamable-http',
          is_authed: false
        }
      })
    });

    assert.equal(config.botId, 'aib9tgHEwLkicK4leYx2rtoFsKO5AJhukyk');
    assert.equal(
      config.authPageUrl,
      'https://work.weixin.qq.com/ai/aiHelper/authorizationPage?str_aibotid=aib9tgHEwLkicK4leYx2rtoFsKO5AJhukyk&type=1&from=chat&forceInnerBrowser=1'
    );
  } finally {
    if (previousBotId === undefined) {
      delete process.env.WECOM_BOT_ID;
    } else {
      process.env.WECOM_BOT_ID = previousBotId;
    }
  }
});

test('fetchWecomDocMcpConfig rejects unsupported url schemes', async () => {
  await assert.rejects(
    fetchWecomDocMcpConfig({
      request: async () => ({
        body: {
          url: 'ftp://example.test/mcp'
        }
      })
    }),
    /unsupported url protocol/
  );
});
