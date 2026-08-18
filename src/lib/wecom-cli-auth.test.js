import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';

import {
  assertOwnerDm,
  authorizeWecomCli,
  extractWecomAuthPageUrl,
  parseWecomReplyEndpoint,
  runOfficialWecomCliAuth,
  sendWecomC4,
  WecomCliAuthFlowError
} from './wecom-cli-auth.js';

const OWNER = 'owner-user';
const ENDPOINT = `${OWNER}|type:p2p|msg:message-1`;
const CONFIG = { owner: { bound: true, user_id: OWNER } };

test('parseWecomReplyEndpoint accepts only a structured private reply endpoint', () => {
  assert.deepEqual(parseWecomReplyEndpoint(ENDPOINT), {
    userId: OWNER,
    type: 'p2p',
    msg: 'message-1'
  });
  assert.throws(
    () => parseWecomReplyEndpoint('group|type:group|msg:m1'),
    (error) => error.code === 'owner_dm_required'
  );
  assert.throws(
    () => parseWecomReplyEndpoint(`${OWNER}|type:p2p|type:p2p|msg:m1`),
    (error) => error.code === 'invalid_endpoint'
  );
});

test('assertOwnerDm rejects a non-owner before authorization starts', () => {
  assert.throws(
    () => assertOwnerDm('someone-else|type:p2p|msg:m1', CONFIG),
    (error) => error instanceof WecomCliAuthFlowError && error.code === 'owner_dm_required'
  );
});

test('extractWecomAuthPageUrl accepts only the official temporary page', () => {
  const valid = 'https://work.weixin.qq.com/ai/qc/gen?source=3&scode=temporary';
  assert.equal(extractWecomAuthPageUrl(`请打开二维码链接扫码:\n${valid}\n`), valid);
  assert.equal(extractWecomAuthPageUrl('https://evil.example/ai/qc/gen?scode=x'), null);
});

test('sendWecomC4 sends content through stdin without a shell', async () => {
  let invocation;
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = {
    end(content) {
      invocation.stdin = content;
      queueMicrotask(() => child.emit('close', 0));
    }
  };

  await sendWecomC4(ENDPOINT, 'secret-safe-message', {
    c4SendPath: '/c4-send.js',
    spawnImpl(command, args, options) {
      invocation = { command, args, options };
      return child;
    }
  });

  assert.equal(invocation.command, 'node');
  assert.deepEqual(invocation.args, ['/c4-send.js', 'wecom', ENDPOINT]);
  assert.equal(invocation.options.shell, undefined);
  assert.equal(invocation.stdin, 'secret-safe-message');
});

test('runOfficialWecomCliAuth emits the official link and generated PNG', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-cli-runner-test-'));
  const qrPath = path.join(cwd, 'qrcode.png');
  let invocation;
  let ready;

  try {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};

    const promise = runOfficialWecomCliAuth({
      cwd,
      qrPath,
      onReady: async (value) => { ready = value; },
      spawnImpl(command, args, options) {
        invocation = { command, args, options };
        queueMicrotask(() => {
          fs.writeFileSync(qrPath, 'png');
          child.stdout.emit(
            'data',
            'https://work.weixin.qq.com/ai/qc/gen?source=3&scode=temporary\n二维码已保存到: qrcode.png\n'
          );
          child.emit('close', 0);
        });
        return child;
      }
    });

    await promise;
    assert.equal(invocation.command, 'wecom-cli');
    assert.deepEqual(invocation.args, [
      'auth', 'init', '--noninteractive', '--no-browser', '--output-qrcode', 'qrcode.png'
    ]);
    assert.equal(invocation.options.shell, undefined);
    assert.equal(ready.qrPath, qrPath);
    assert.match(ready.pageUrl, /^https:\/\/work\.weixin\.qq\.com\/ai\/qc\/gen\?/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('runOfficialWecomCliAuth fails closed when auth material is missing', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-cli-runner-test-'));

  try {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};

    await assert.rejects(
      runOfficialWecomCliAuth({
        cwd,
        qrPath: path.join(cwd, 'qrcode.png'),
        onReady: async () => {},
        spawnImpl() {
          queueMicrotask(() => child.emit('close', 0));
          return child;
        }
      }),
      (error) => error.code === 'auth_material_missing'
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('runOfficialWecomCliAuth contains a synchronous delivery failure', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-cli-runner-test-'));
  const qrPath = path.join(cwd, 'qrcode.png');
  let killed = false;

  try {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => { killed = true; };

    const promise = runOfficialWecomCliAuth({
      cwd,
      qrPath,
      onReady() {
        throw new WecomCliAuthFlowError('delivery_failed', 'delivery rejected');
      },
      spawnImpl() {
        queueMicrotask(() => {
          fs.writeFileSync(qrPath, 'png');
          child.stdout.emit(
            'data',
            'https://work.weixin.qq.com/ai/qc/gen?source=3&scode=temporary\n' +
              '二维码已保存到: qrcode.png\n'
          );
          setImmediate(() => child.emit('close', null));
        });
        return child;
      }
    });

    await assert.rejects(promise, (error) => error.code === 'delivery_failed');
    assert.equal(killed, true);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('authorizeWecomCli returns the link and QR to the same owner DM', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-cli-auth-test-'));
  const sent = [];

  try {
    const result = await authorizeWecomCli({
      endpoint: ENDPOINT,
      config: CONFIG,
      tempRoot,
      sendMessage: async (endpoint, message) => sent.push({ endpoint, message }),
      runAuth: async ({ qrPath, onReady }) => {
        fs.writeFileSync(qrPath, 'png');
        await onReady({
          pageUrl: 'https://work.weixin.qq.com/ai/qc/gen?source=3&scode=temporary',
          qrPath
        });
      },
      checkStatus: () => true
    });

    assert.deepEqual(result, {
      ok: true,
      status: 'authorized',
      retryOriginalOperation: true
    });
    assert.equal(sent.length, 3);
    assert.ok(sent.every((item) => item.endpoint === ENDPOINT));
    assert.match(sent[0].message, /^企业微信 CLI 需要 owner 授权/);
    assert.match(sent[1].message, /^\[MEDIA:image\]/);
    assert.equal(sent[2].message, '企业微信 CLI 授权成功，正在重试刚才的操作。');
    assert.deepEqual(fs.readdirSync(tempRoot), []);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('authorizeWecomCli reports an expired session without leaking its error', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-cli-auth-test-'));
  const sent = [];

  try {
    await assert.rejects(
      authorizeWecomCli({
        endpoint: ENDPOINT,
        config: CONFIG,
        tempRoot,
        sendMessage: async (_endpoint, message) => sent.push(message),
        runAuth: async () => {
          throw new WecomCliAuthFlowError('auth_failed_or_expired', 'contains-sensitive-detail');
        },
        checkStatus: () => false
      }),
      (error) => error.code === 'auth_failed_or_expired'
    );
    assert.deepEqual(sent, [
      '企业微信 CLI 授权未完成或已超时。需要时请在当前私聊重新发起。'
    ]);
    assert.deepEqual(fs.readdirSync(tempRoot), []);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('authorizeWecomCli rejects overlapping sessions before starting the CLI', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-cli-auth-test-'));
  fs.writeFileSync(path.join(tempRoot, 'active.lock'), 'existing\n', { mode: 0o600 });
  let started = false;

  try {
    await assert.rejects(
      authorizeWecomCli({
        endpoint: ENDPOINT,
        config: CONFIG,
        tempRoot,
        runAuth: async () => { started = true; },
        sendMessage: async () => {}
      }),
      (error) => error.code === 'auth_in_progress'
    );
    assert.equal(started, false);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
