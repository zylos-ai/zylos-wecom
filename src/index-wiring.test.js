/**
 * Wiring test for src/index.js: runs the real service entry point in a child
 * process against a local fake WeCom WebSocket server and a fake C4 receiver,
 * with HOME pointed at a temp dir (no writes outside it, no process.exit in
 * the test process). Proves the access gate's decision is honored end to end:
 * blocked group / DM messages are NOT forwarded to the Agent, allowed ones are,
 * and only the blocked group mention gets a notice reply.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import { GROUP_NOT_ENABLED_NOTICE, GROUP_NO_PERMISSION_NOTICE } from './lib/access-notice.js';

const INDEX_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.js');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function readC4Calls(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function msgFrame({ reqId, msgId, chatType, chatId, userId, text }) {
  return JSON.stringify({
    cmd: 'aibot_msg_callback',
    headers: { req_id: reqId },
    body: {
      msgid: msgId,
      chattype: chatType,
      ...(chatId ? { chatid: chatId } : {}),
      from: { userid: userId, name: userId },
      msgtype: 'text',
      text: { content: text }
    }
  });
}

test('index.js forwards only messages allowed by the access gate', { timeout: 30000 }, async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-wiring-'));
  const dataDir = path.join(home, 'zylos/components/wecom');
  const c4Dir = path.join(home, 'zylos/.claude/skills/comm-bridge/scripts');
  const c4Log = path.join(home, 'c4-calls.jsonl');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(c4Dir, { recursive: true });
  fs.writeFileSync(
    path.join(c4Dir, 'c4-receive.js'),
    `const fs = require('fs');
const a = process.argv.slice(2);
const get = (k) => a[a.indexOf(k) + 1];
fs.appendFileSync(${JSON.stringify(c4Log)}, JSON.stringify({ endpoint: get('--endpoint'), content: get('--content') }) + '\\n');
process.stdout.write('{"ok":true}');
`
  );
  // Make the fake receiver CommonJS regardless of any parent package.json.
  fs.writeFileSync(path.join(c4Dir, 'package.json'), '{"type":"commonjs"}');

  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((r) => wss.once('listening', r));
  const wsPort = wss.address().port;
  const internalPort = await freePort();

  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    enabled: true,
    internal_port: internalPort,
    owner: { bound: true, user_id: 'owner1', name: 'Owner' },
    dmPolicy: 'owner',
    dmAllowFrom: [],
    groupPolicy: 'allowlist',
    groups: { chatOK: { name: 'OK' }, chatRestricted: { name: 'R', allowFrom: ['owner1'] } },
    message: { locale: 'en-US' },
    ws: { url: `ws://127.0.0.1:${wsPort}`, reconnect_initial_delay: 60000 },
    doc: { fetch_timeout_ms: 200 }
  }));

  const responds = [];
  let socket = null;
  wss.on('connection', (s) => {
    socket = s;
    s.on('message', (raw) => {
      const frame = JSON.parse(raw.toString());
      const reqId = frame.headers?.req_id;
      if (frame.cmd === 'aibot_subscribe') {
        s.send(JSON.stringify({ headers: { req_id: reqId }, errcode: 0, errmsg: 'ok' }));
      } else if (frame.cmd === 'aibot_respond_msg' || frame.cmd === 'aibot_send_msg') {
        responds.push(frame);
        s.send(JSON.stringify({ cmd: frame.cmd, headers: { req_id: reqId }, body: { code: 0 } }));
      }
    });
  });

  let output = '';
  const child = spawn(process.execPath, [INDEX_PATH], {
    env: {
      PATH: process.env.PATH,
      HOME: home,
      LANG: 'en_US.UTF-8',
      WECOM_BOT_ID: 'test-bot',
      WECOM_BOT_SECRET: 'test-secret'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });

  t.after(async () => {
    if (child.exitCode === null) {
      child.kill('SIGKILL');
      await new Promise((r) => child.once('exit', r));
    }
    await new Promise((r) => wss.close(r));
    fs.rmSync(home, { recursive: true, force: true });
  });

  try {
    await waitFor(() => /Authenticated successfully/.test(output), 10000, 'authentication');

    const send = (f) => socket.send(msgFrame(f));
    send({ reqId: 'r-g-blocked', msgId: 'm-g-blocked', chatType: 'group', chatId: 'chatNew', userId: 'u1', text: 'blocked group' });
    send({ reqId: 'r-g-noperm', msgId: 'm-g-noperm', chatType: 'group', chatId: 'chatRestricted', userId: 'u1', text: 'no perm group' });
    send({ reqId: 'r-dm-blocked', msgId: 'm-dm-blocked', chatType: 'single', userId: 'u2', text: 'blocked dm' });
    send({ reqId: 'r-g-ok', msgId: 'm-g-ok', chatType: 'group', chatId: 'chatOK', userId: 'u1', text: 'allowed group' });
    send({ reqId: 'r-dm-ok', msgId: 'm-dm-ok', chatType: 'single', userId: 'owner1', text: 'allowed dm' });

    await waitFor(() => readC4Calls(c4Log).length >= 2, 15000, 'allowed messages forwarded to C4');
    // Give any (incorrectly) forwarded blocked message time to show up.
    await new Promise((r) => setTimeout(r, 500));

    const endpoints = readC4Calls(c4Log).map((c) => c.endpoint).sort();
    assert.deepEqual(endpoints, [
      'chatOK|type:group|msg:m-g-ok',
      'owner1|type:p2p|msg:m-dm-ok'
    ]);

    const notices = responds
      .map((f) => ({ reqId: f.headers.req_id, text: f.body?.markdown?.content }))
      .sort((a, b) => a.reqId.localeCompare(b.reqId));
    assert.deepEqual(notices, [
      { reqId: 'r-g-blocked', text: GROUP_NOT_ENABLED_NOTICE },
      { reqId: 'r-g-noperm', text: GROUP_NO_PERMISSION_NOTICE }
    ]);
  } catch (err) {
    err.message += `\n--- index.js output ---\n${output}`;
    throw err;
  }
});
