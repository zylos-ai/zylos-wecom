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
import { GENERIC_REJECT_REPLY, UNCERTAIN_REPLY } from './lib/c4.js';

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

/**
 * Start src/index.js against a fake WeCom server and a fake multi-session
 * c4-receive (manifest lists --session-group). The fake receiver logs its argv
 * and answers by message text: "reject-not-stored", "reject-committed",
 * "crash", otherwise success.
 */
async function startMultiSessionService(t, { journalLines = [] } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-ms-wiring-'));
  const dataDir = path.join(home, 'zylos/components/wecom');
  const c4Dir = path.join(home, 'zylos/.claude/skills/comm-bridge/scripts');
  const c4Log = path.join(home, 'c4-calls.jsonl');
  const journalPath = path.join(dataDir, 'message-delivery.jsonl');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(c4Dir, { recursive: true });
  fs.writeFileSync(path.join(c4Dir, 'c4-receive.js'), `const fs = require('fs');
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(c4Log)}, JSON.stringify(a) + '\\n');
const content = a[a.indexOf('--content') + 1];
const reject = (persisted) => {
  process.stdout.write(JSON.stringify({ ok: false, error: { code: 'X', message: 'internal core text', persisted } }));
  process.exit(1);
};
if (content.includes('reject-not-stored')) reject([]);
else if (content.includes('reject-committed')) reject(['D1']);
else if (content.includes('crash')) process.exit(3);
else process.stdout.write('{"ok":true}');
`);
  fs.writeFileSync(path.join(c4Dir, 'package.json'), '{"type":"commonjs"}');
  fs.writeFileSync(path.join(c4Dir, 'c4-receive-options.json'),
    JSON.stringify({ options: { '--session-group': { takesValue: true } } }));
  if (journalLines.length) fs.writeFileSync(journalPath, journalLines.map((l) => JSON.stringify(l)).join('\n') + '\n');

  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((r) => wss.once('listening', r));
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    enabled: true,
    internal_port: await freePort(),
    owner: { bound: true, user_id: 'owner1', name: 'Owner' },
    dmPolicy: 'owner',
    dmAllowFrom: [],
    groupPolicy: 'allowlist',
    groups: { chatOK: { name: 'OK' } },
    message: { locale: 'en-US' },
    ws: { url: `ws://127.0.0.1:${wss.address().port}`, reconnect_initial_delay: 60000 },
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

  const state = { output: '' };
  const child = spawn(process.execPath, [INDEX_PATH], {
    env: { PATH: process.env.PATH, HOME: home, LANG: 'en_US.UTF-8', WECOM_BOT_ID: 'test-bot', WECOM_BOT_SECRET: 'test-secret' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (d) => { state.output += d; });
  child.stderr.on('data', (d) => { state.output += d; });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill('SIGKILL');
      await new Promise((r) => child.once('exit', r));
    }
    await new Promise((r) => wss.close(r));
    fs.rmSync(home, { recursive: true, force: true });
  });

  await waitFor(() => /Authenticated successfully/.test(state.output), 10000, 'authentication');
  return {
    state,
    responds,
    send: (f) => socket.send(msgFrame(f)),
    c4Calls: () => readC4Calls(c4Log),
    journal: () => (fs.existsSync(journalPath)
      ? fs.readFileSync(journalPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
      : [])
  };
}

const argValue = (argv, name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);

test('multi-session Core: groups per chat, rejections notify the user once, nothing is resent', { timeout: 30000 }, async (t) => {
  const svc = await startMultiSessionService(t);
  try {
    svc.send({ reqId: 'r-dm-ok', msgId: 'm-dm-ok', chatType: 'single', userId: 'owner1', text: 'hello' });
    svc.send({ reqId: 'r-g-ok', msgId: 'm-g-ok', chatType: 'group', chatId: 'chatOK', userId: 'owner1', text: 'hello group' });
    svc.send({ reqId: 'r-not-stored', msgId: 'm-not-stored', chatType: 'single', userId: 'owner1', text: 'reject-not-stored' });
    svc.send({ reqId: 'r-committed', msgId: 'm-committed', chatType: 'single', userId: 'owner1', text: 'reject-committed' });
    svc.send({ reqId: 'r-crash', msgId: 'm-crash', chatType: 'single', userId: 'owner1', text: 'crash' });

    await waitFor(() => svc.c4Calls().length >= 5 && svc.responds.length >= 2, 15000, 'five C4 calls and two notices');
    // WeCom redelivers a callback it considers unanswered: same msgid again.
    svc.send({ reqId: 'r-crash-2', msgId: 'm-crash', chatType: 'single', userId: 'owner1', text: 'crash' });
    await new Promise((r) => setTimeout(r, 500));

    const calls = svc.c4Calls();
    assert.equal(calls.length, 5, 'every message forwarded exactly once');
    const groups = Object.fromEntries(calls.map((argv) => [argValue(argv, '--endpoint').split('|msg:')[1], argValue(argv, '--session-group')]));
    assert.deepEqual(groups, {
      'm-dm-ok': 'dm-owner1',
      'm-g-ok': 'group-chatOK',
      'm-not-stored': 'dm-owner1',
      'm-committed': 'dm-owner1',
      'm-crash': 'dm-owner1'
    });

    const notices = svc.responds
      .map((f) => ({ reqId: f.headers.req_id, text: f.body?.markdown?.content }))
      .sort((a, b) => a.reqId.localeCompare(b.reqId));
    assert.deepEqual(notices, [
      { reqId: 'r-crash', text: UNCERTAIN_REPLY },
      { reqId: 'r-not-stored', text: GENERIC_REJECT_REPLY }
    ]);
    assert.ok(!notices.some((n) => /internal core text/.test(n.text)));

    const finalStates = Object.fromEntries(svc.journal().map((e) => [e.msgId, e.state]));
    assert.deepEqual(finalStates, {
      'm-dm-ok': 'delivered',
      'm-g-ok': 'delivered',
      'm-not-stored': 'failed',
      'm-committed': 'delivered',
      'm-crash': 'failed'
    });
  } catch (err) {
    err.message += `\n--- index.js output ---\n${svc.state.output}`;
    throw err;
  }
});

test('a message still pending at startup is finished, not forwarded again', { timeout: 30000 }, async (t) => {
  const record = {
    msgId: 'm-interrupted',
    receivedAt: new Date().toISOString(),
    content: '[WeCom DM] Owner said: hello',
    endpoint: 'owner1|type:p2p|msg:m-interrupted',
    historyChatId: 'owner1',
    historyEntry: { msgId: 'm-interrupted', text: 'hello', timestamp: new Date().toISOString() }
  };
  const svc = await startMultiSessionService(t, {
    journalLines: [{ version: 1, state: 'pending', msgId: record.msgId, receivedAt: record.receivedAt, record }]
  });
  try {
    // The platform redelivers the same msgid after the restart.
    svc.send({ reqId: 'r-again', msgId: 'm-interrupted', chatType: 'single', userId: 'owner1', text: 'hello' });
    await new Promise((r) => setTimeout(r, 1000));

    assert.deepEqual(svc.c4Calls(), []);
    const last = svc.journal().filter((e) => e.msgId === 'm-interrupted').at(-1);
    assert.equal(last.state, 'failed');
    assert.equal(last.reason, 'interrupted');
  } catch (err) {
    err.message += `\n--- index.js output ---\n${svc.state.output}`;
    throw err;
  }
});
