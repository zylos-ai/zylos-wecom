import fs from 'fs';
import os from 'os';
import path from 'path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildGenerateUrl, getPlatformCode } from './scan-onboard.js';

test('getPlatformCode maps supported platforms', () => {
  assert.equal(getPlatformCode('darwin'), 1);
  assert.equal(getPlatformCode('win32'), 2);
  assert.equal(getPlatformCode('linux'), 3);
  assert.equal(getPlatformCode('freebsd'), 0);
});

test('buildGenerateUrl keeps the verified OpenClaw-compatible source', () => {
  assert.equal(
    buildGenerateUrl('linux'),
    'https://work.weixin.qq.com/ai/qc/generate?source=wecom-cli&plat=3'
  );
});

test('startScanSession creates a reusable QR session payload', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-wecom-scan-start-'));
  process.env.HOME = homeDir;

  const originalFetch = global.fetch;
  global.fetch = async () =>
    new Response(
      JSON.stringify({
        data: {
          scode: 'scode-1',
          auth_url: 'https://example.com/wecom-auth'
        }
      }),
      { status: 200 }
    );

  try {
    const module = await import(`./scan-onboard.js?start=${Date.now()}`);
    const sessionPath = path.join(homeDir, 'session.json');
    const result = await module.startScanSession({
      locale: 'en-US',
      sessionPath,
      now: new Date('2026-04-02T00:00:00.000Z').getTime()
    });

    assert.equal(result.status, 'qr_ready');
    assert.equal(result.sessionId.startsWith('wcs_'), true);
    assert.equal(result.scode, 'scode-1');
    assert.equal(result.authUrl, 'https://example.com/wecom-auth');
    assert.equal(typeof result.qrImage, 'string');
    assert.equal(result.qrImage.length > 0, true);
    assert.equal(result.expiresInSec, 300);

    const persisted = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
    assert.equal(persisted.scode, 'scode-1');
    assert.equal(persisted.status, 'qr_ready');
  } finally {
    global.fetch = originalFetch;
  }
});

test('pollScanSession persists credentials and clears the session on success', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-wecom-scan-poll-'));

  const originalFetch = global.fetch;
  global.fetch = async () =>
    new Response(
      JSON.stringify({
        data: {
          status: 'success',
          bot_info: {
            botid: 'bot-123',
            secret: 'secret-456'
          }
        }
      }),
      { status: 200 }
    );

  try {
    const module = await import(`./scan-onboard.js?poll=${Date.now()}`);
    const sessionPath = path.join(homeDir, 'scan-session.json');
    fs.writeFileSync(
      sessionPath,
      JSON.stringify({
        sessionId: 'wcs_abc',
        scode: 'scode-1',
        authUrl: 'https://example.com/wecom-auth',
        status: 'qr_ready',
        createdAt: '2026-04-02T00:00:00.000Z',
        expiresAt: '2026-04-02T00:05:00.000Z'
      }),
      'utf8'
    );

    const result = await module.pollScanSession({
      locale: 'en-US',
      sessionId: 'wcs_abc',
      sessionPath,
      now: new Date('2026-04-02T00:01:00.000Z').getTime(),
      persistCredentials: ({ bot_id, secret }) => {
        const envPath = path.join(homeDir, 'zylos/.env');
        fs.mkdirSync(path.dirname(envPath), { recursive: true });
        fs.writeFileSync(envPath, `WECOM_BOT_ID=${bot_id}\nWECOM_BOT_SECRET=${secret}\n`, 'utf8');
        return envPath;
      }
    });

    assert.deepEqual(result, {
      status: 'connected',
      botId: 'bot-123',
      botSecret: 'secret-456'
    });
    assert.equal(fs.existsSync(sessionPath), false);
    assert.equal(
      fs.readFileSync(path.join(homeDir, 'zylos/.env'), 'utf8'),
      'WECOM_BOT_ID=bot-123\nWECOM_BOT_SECRET=secret-456\n'
    );
  } finally {
    global.fetch = originalFetch;
  }
});
