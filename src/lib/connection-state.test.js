import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  writeConnectionState,
  subscribeAckToState,
  resolveConnectionStatePath,
  lastWrittenState,
  CONNECTION_STATES
} from './connection-state.js';

function withTempHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-wecom-home-'));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    return fn(home);
  } finally {
    process.env.HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('writeConnectionState writes the contract shape atomically at the openmax path', () => {
  withTempHome((home) => {
    writeConnectionState('connected');

    const file = resolveConnectionStatePath();
    assert.equal(file, path.join(home, 'zylos/components/wecom/runtime/connection-state.json'));
    const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(payload.state, 'connected');
    assert.ok(CONNECTION_STATES.includes(payload.state));
    assert.equal('detail' in payload, false); // empty detail omitted
    assert.ok(Number.isFinite(Date.parse(payload.updatedAt)), 'updatedAt must be ISO8601');
    assert.ok(Math.abs(Date.now() - Date.parse(payload.updatedAt)) < 5_000, 'updatedAt must be now');

    // atomic write: no tmp files left behind
    const leftovers = fs.readdirSync(path.dirname(file)).filter((f) => f.includes('.tmp.'));
    assert.deepEqual(leftovers, []);
    assert.equal(lastWrittenState(), 'connected');
  });
});

test('writeConnectionState replaces the previous state and records the detail (collapsed + capped)', () => {
  withTempHome(() => {
    writeConnectionState('connecting');
    writeConnectionState('auth_failed', '  code 301002:\n   invalid bot secret  ');

    const payload = JSON.parse(fs.readFileSync(resolveConnectionStatePath(), 'utf8'));
    assert.equal(payload.state, 'auth_failed');
    assert.equal(payload.detail, 'code 301002: invalid bot secret'); // whitespace collapsed
    assert.equal(lastWrittenState(), 'auth_failed');

    writeConnectionState('disconnected', 'x'.repeat(500));
    const capped = JSON.parse(fs.readFileSync(resolveConnectionStatePath(), 'utf8'));
    assert.equal(capped.detail.length, 200); // bounded detail
  });
});

test('writeConnectionState never throws when the runtime dir cannot be created (best-effort)', () => {
  withTempHome((home) => {
    // Make `zylos` a FILE so mkdir -p of .../zylos/components/... fails.
    fs.writeFileSync(path.join(home, 'zylos'), 'not a directory');
    assert.doesNotThrow(() => writeConnectionState('connected'));
  });
});

test('subscribeAckToState: errcode 0 / body.code 0 → connected', () => {
  assert.deepEqual(subscribeAckToState({ errcode: 0 }), { state: 'connected', detail: '' });
  assert.deepEqual(subscribeAckToState({ body: { code: 0 } }), { state: 'connected', detail: '' });
});

test('subscribeAckToState: non-zero ack → auth_failed with `code <errcode>: <errmsg>` detail', () => {
  assert.deepEqual(
    subscribeAckToState({ errcode: 301002, errmsg: 'invalid bot secret' }),
    { state: 'auth_failed', detail: 'code 301002: invalid bot secret' }
  );
  // body-shaped error frame
  assert.deepEqual(
    subscribeAckToState({ body: { code: 40001, msg: 'invalid credential' } }),
    { state: 'auth_failed', detail: 'code 40001: invalid credential' }
  );
  // degenerate frame still yields a usable detail
  assert.deepEqual(subscribeAckToState({}), { state: 'auth_failed', detail: 'code unknown' });
});
