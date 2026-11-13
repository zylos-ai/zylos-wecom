import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFile } from 'node:child_process';
import {
  GENERIC_REJECT_REPLY,
  UNCERTAIN_REPLY,
  buildC4ReceiveArgs,
  c4ReceiveSupportsOption,
  sendToC4,
  withWatchdog
} from './c4.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-c4-'));
const scriptPath = path.join(tmp, 'c4-receive.mjs');
const manifestPath = path.join(tmp, 'c4-receive-options.json');
const callLog = path.join(tmp, 'calls.jsonl');

// Fake c4-receive: logs its argv, then answers according to FAKE_C4_MODE.
fs.writeFileSync(scriptPath, `
import fs from 'node:fs';
fs.appendFileSync(${JSON.stringify(callLog)}, JSON.stringify(process.argv.slice(2)) + '\\n');
const mode = process.env.FAKE_C4_MODE;
const reject = (persisted) => {
  const error = { code: 'SESSION_GROUP_INVALID', message: 'internal core text' };
  if (persisted !== undefined) error.persisted = persisted;
  process.stdout.write(JSON.stringify({ ok: false, error }));
  process.exit(1);
};
if (mode === 'ok') process.stdout.write(JSON.stringify({ ok: true }));
else if (mode === 'committed') reject(['D1']);
else if (mode === 'not_stored') reject([]);
else if (mode === 'unknown_persisted') reject(null);
else if (mode === 'no_persisted') reject(undefined);
else if (mode === 'crash') { process.stderr.write('boom'); process.exit(3); }
`);

const ENDPOINT = 'li.si@corp|type:p2p|msg:m1';
const GROUP = 'dm-li.si:corp';
const BASE_ARGS = [scriptPath, '--channel', 'wecom', '--endpoint', ENDPOINT, '--json', '--content', 'hi'];
const SUPPORTED = { options: { '--session-group': { takesValue: true } } };
const quiet = { log() {}, warn() {}, error() {} };

function setManifest(value) {
  if (value === undefined) fs.rmSync(manifestPath, { force: true });
  else fs.writeFileSync(manifestPath, typeof value === 'string' ? value : JSON.stringify(value));
}

function calls() {
  if (!fs.existsSync(callLog)) return [];
  return fs.readFileSync(callLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

async function send(mode, { endpoint = ENDPOINT, logger = quiet } = {}) {
  fs.rmSync(callLog, { force: true });
  process.env.FAKE_C4_MODE = mode;
  return sendToC4({ scriptPath, endpoint, content: 'hi', logger, retryDelayMs: 10 });
}

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('manifest gates --session-group; anything but an own key means unsupported', () => {
  for (const value of [undefined, 'not json', '[]', 'null', { options: [] }, { options: { '--channel': {} } }]) {
    setManifest(value);
    assert.equal(c4ReceiveSupportsOption(scriptPath, '--session-group'), false, JSON.stringify(value));
    assert.deepEqual(buildC4ReceiveArgs({ scriptPath, endpoint: ENDPOINT, content: 'hi', sessionGroup: GROUP }), BASE_ARGS);
  }
  setManifest(SUPPORTED);
  assert.deepEqual(buildC4ReceiveArgs({ scriptPath, endpoint: ENDPOINT, content: 'hi', sessionGroup: GROUP }),
    [...BASE_ARGS, '--session-group', GROUP]);
});

test('older Core receives exactly the pre-change arguments, even for unmappable endpoints', async () => {
  setManifest(undefined);
  assert.deepEqual(await send('ok'), { outcome: 'sent', notice: null });
  assert.deepEqual(calls(), [BASE_ARGS.slice(1)]);
  assert.deepEqual(await send('ok', { endpoint: 'bad id|type:p2p' }), { outcome: 'sent', notice: null });
  assert.equal(calls().length, 1);
});

test('multi-session Core receives the group', async () => {
  setManifest(SUPPORTED);
  assert.deepEqual(await send('ok'), { outcome: 'sent', notice: null });
  assert.deepEqual(calls(), [[...BASE_ARGS.slice(1), '--session-group', GROUP]]);
});

test('unmappable endpoint on multi-session Core is never sent', async () => {
  setManifest(SUPPORTED);
  assert.deepEqual(await send('ok', { endpoint: 'bad id|type:p2p' }), { outcome: 'not_stored', notice: GENERIC_REJECT_REPLY });
  assert.deepEqual(calls(), []);
});

test('rejections are classified by persisted, never resent, Core text never shown', async () => {
  setManifest(SUPPORTED);
  const cases = [
    ['committed', { outcome: 'committed', notice: null }],
    ['not_stored', { outcome: 'not_stored', notice: GENERIC_REJECT_REPLY }],
    ['unknown_persisted', { outcome: 'uncertain', notice: UNCERTAIN_REPLY }],
    ['no_persisted', { outcome: 'uncertain', notice: UNCERTAIN_REPLY }]
  ];
  for (const [mode, expected] of cases) {
    assert.deepEqual(await send(mode), expected, mode);
    const argv = calls();
    assert.equal(argv.length, 1, `${mode}: called once`);
    assert.ok(argv[0].includes('--session-group'), `${mode}: group never dropped`);
  }
});

test('a process that ran but failed without a result is not retried', async () => {
  setManifest(SUPPORTED);
  assert.deepEqual(await send('crash'), { outcome: 'uncertain', notice: UNCERTAIN_REPLY });
  assert.equal(calls().length, 1);
});

const spawnError = () => Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT', syscall: 'spawn' });

/** execFile that fails to spawn `failures` times, then runs the real fake receiver. */
function flakySpawn(failures) {
  let count = 0;
  const impl = (cmd, args, options, cb) => {
    count += 1;
    if (count <= failures) { setImmediate(() => cb(spawnError(), '', '')); return; }
    execFile(cmd, args, options, cb);
  };
  return { impl, attempts: () => count };
}

async function sendWith(mode, extra) {
  fs.rmSync(callLog, { force: true });
  process.env.FAKE_C4_MODE = mode;
  return sendToC4({ scriptPath, endpoint: ENDPOINT, content: 'hi', logger: quiet, retryDelayMs: 10, ...extra });
}

test('runs c4-receive with the current Node binary, not PATH lookup', async () => {
  setManifest(SUPPORTED);
  let command;
  const execFileImpl = (cmd, args, options, cb) => { command = cmd; execFile(cmd, args, options, cb); };
  assert.equal((await sendWith('ok', { execFileImpl })).outcome, 'sent');
  assert.equal(command, process.execPath);
});

test('a process that never started is retried once; if it never starts, nothing was stored', async () => {
  setManifest(SUPPORTED);
  const twice = flakySpawn(2);
  assert.deepEqual(await sendWith('ok', { execFileImpl: twice.impl }), { outcome: 'not_stored', notice: GENERIC_REJECT_REPLY });
  assert.equal(twice.attempts(), 2);
  assert.deepEqual(calls(), []);

  const once = flakySpawn(1);
  const warnings = [];
  const logger = { ...quiet, warn: (msg) => warnings.push(msg) };
  assert.deepEqual(await sendWith('ok', { execFileImpl: once.impl, logger }), { outcome: 'sent', notice: null });
  assert.equal(once.attempts(), 2);
  assert.match(warnings[0], /did not start/);
  assert.equal(calls().length, 1);
});

test('NUL bytes are removed from the content instead of failing the message', async () => {
  setManifest(SUPPORTED);
  assert.deepEqual(await sendWith('ok', { content: 'a\0b' }), { outcome: 'sent', notice: null });
  assert.equal(calls()[0][calls()[0].indexOf('--content') + 1], 'ab');
});

test('arguments that cannot be passed are reported, not thrown or retried', async () => {
  setManifest(SUPPORTED);
  let attempts = 0;
  const execFileImpl = () => { attempts += 1; throw Object.assign(new TypeError('bad arg'), { code: 'ERR_INVALID_ARG_VALUE' }); };
  assert.deepEqual(await sendWith('ok', { execFileImpl }), { outcome: 'not_stored', notice: GENERIC_REJECT_REPLY });
  assert.equal(attempts, 1);
});

test('watchdog stops waiting for a hung c4-receive without resending, and logs the late result', async () => {
  const logs = [];
  const logger = { error: (m) => logs.push(m), warn: (m) => logs.push(m) };
  let finish;
  const hung = new Promise((resolve) => { finish = resolve; });
  const result = await withWatchdog(hung, { ms: 20, label: 'm1', logger });
  assert.deepEqual(result, { outcome: 'uncertain', notice: UNCERTAIN_REPLY });
  assert.match(logs[0], /still running after 20ms/);
  finish({ outcome: 'sent', notice: null });
  await new Promise((r) => setImmediate(r));
  assert.match(logs[1], /finished late: sent/);

  const fast = await withWatchdog(Promise.resolve({ outcome: 'sent', notice: null }), { ms: 20, logger });
  assert.deepEqual(fast, { outcome: 'sent', notice: null });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(logs.length, 2, 'no watchdog log after a timely result');
});
