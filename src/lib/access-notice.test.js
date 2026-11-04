import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GROUP_BLOCK_REASON,
  applyAccessGate,
  evaluateDmAccess,
  GROUP_NOT_ENABLED_NOTICE,
  GROUP_NO_PERMISSION_NOTICE,
  OWNER_GUIDE_TEXT,
  bindOwnerIfUnbound,
  evaluateGroupAccess,
  renderGroupBlockedNotice,
  sendNoticeSafely
} from './access-notice.js';

const OWNER = { bound: true, user_id: 'owner1', name: 'Owner' };

test('evaluateGroupAccess: allowlist + unconfigured group -> not enabled', () => {
  const result = evaluateGroupAccess({ groupPolicy: 'allowlist', groups: {} }, 'chatA', 'u1');
  assert.deepEqual(result, { allowed: false, reason: GROUP_BLOCK_REASON.NOT_ENABLED });
});

test('evaluateGroupAccess: default policy is allowlist', () => {
  const result = evaluateGroupAccess({}, 'chatA', 'u1');
  assert.deepEqual(result, { allowed: false, reason: GROUP_BLOCK_REASON.NOT_ENABLED });
});

test('evaluateGroupAccess: disabled policy -> not enabled', () => {
  const result = evaluateGroupAccess(
    { groupPolicy: 'disabled', groups: { chatA: { name: 'A' } } },
    'chatA',
    'u1'
  );
  assert.deepEqual(result, { allowed: false, reason: GROUP_BLOCK_REASON.NOT_ENABLED });
});

test('evaluateGroupAccess: configured group, sender outside allowFrom -> no permission', () => {
  const config = { groupPolicy: 'allowlist', groups: { chatA: { name: 'A', allowFrom: ['u2'] } } };
  assert.deepEqual(
    evaluateGroupAccess(config, 'chatA', 'u1'),
    { allowed: false, reason: GROUP_BLOCK_REASON.SENDER_NOT_ALLOWED }
  );
  assert.deepEqual(evaluateGroupAccess(config, 'chatA', 'u2'), { allowed: true });
});

test('evaluateGroupAccess: configured group without allowFrom or with * allows everyone', () => {
  const config = {
    groupPolicy: 'allowlist',
    groups: { chatA: { name: 'A' }, chatB: { name: 'B', allowFrom: ['*'] } }
  };
  assert.deepEqual(evaluateGroupAccess(config, 'chatA', 'u1'), { allowed: true });
  assert.deepEqual(evaluateGroupAccess(config, 'chatB', 'u1'), { allowed: true });
});

test('evaluateGroupAccess: non-array allowFrom fails closed', () => {
  const config = { groupPolicy: 'allowlist', groups: { chatA: { name: 'A', allowFrom: 'u1' } } };
  assert.deepEqual(
    evaluateGroupAccess(config, 'chatA', 'u1'),
    { allowed: false, reason: GROUP_BLOCK_REASON.SENDER_NOT_ALLOWED }
  );
  assert.deepEqual(
    evaluateGroupAccess({ ...config, groups: { chatA: { allowFrom: { u1: true } } } }, 'chatA', 'u1'),
    { allowed: false, reason: GROUP_BLOCK_REASON.SENDER_NOT_ALLOWED }
  );
});

test('evaluateDmAccess follows dmPolicy and fails closed on malformed dmAllowFrom', () => {
  assert.equal(evaluateDmAccess({ owner: OWNER }, 'owner1'), true);
  assert.equal(evaluateDmAccess({ owner: OWNER }, 'u1'), false);
  assert.equal(evaluateDmAccess({ dmPolicy: 'open' }, 'u1'), true);
  assert.equal(evaluateDmAccess({ dmPolicy: 'allowlist', dmAllowFrom: ['u1'] }, 'u1'), true);
  assert.equal(evaluateDmAccess({ dmPolicy: 'allowlist', dmAllowFrom: ['u2'] }, 'u1'), false);
  assert.equal(evaluateDmAccess({ dmPolicy: 'allowlist', dmAllowFrom: 'u1' }, 'u1'), false);
});

test('evaluateGroupAccess: unknown groupPolicy -> deny (not enabled)', () => {
  assert.deepEqual(
    evaluateGroupAccess({ groupPolicy: 'bogus', groups: { chatA: { name: 'A' } } }, 'chatA', 'u1'),
    { allowed: false, reason: GROUP_BLOCK_REASON.NOT_ENABLED }
  );
});

test('evaluateGroupAccess: allowFrom [] / null / missing -> allow everyone in a configured group', () => {
  const config = {
    groupPolicy: 'allowlist',
    groups: { empty: { allowFrom: [] }, nul: { allowFrom: null }, missing: { name: 'M' } }
  };
  for (const chatId of ['empty', 'nul', 'missing']) {
    assert.deepEqual(evaluateGroupAccess(config, chatId, 'u1'), { allowed: true }, chatId);
  }
});

test('evaluateDmAccess: unknown dmPolicy -> deny (owner still allowed)', () => {
  assert.equal(evaluateDmAccess({ dmPolicy: 'bogus', dmAllowFrom: ['u1'] }, 'u1'), false);
  assert.equal(evaluateDmAccess({ dmPolicy: 'bogus', owner: OWNER }, 'owner1'), true);
});

test('evaluateGroupAccess: open policy and owner always allowed', () => {
  assert.deepEqual(evaluateGroupAccess({ groupPolicy: 'open' }, 'chatA', 'u1'), { allowed: true });
  assert.deepEqual(
    evaluateGroupAccess({ groupPolicy: 'disabled', owner: OWNER }, 'chatA', 'owner1'),
    { allowed: true }
  );
  assert.deepEqual(
    evaluateGroupAccess({ groupPolicy: 'allowlist', owner: OWNER, groups: {} }, 'chatA', 'owner1'),
    { allowed: true }
  );
});

test('renderGroupBlockedNotice returns the fixed Chinese notices', () => {
  assert.equal(GROUP_NOT_ENABLED_NOTICE, '本群还没开通，请联系 Agent 管理者开启');
  assert.equal(GROUP_NO_PERMISSION_NOTICE, '你在本群暂无权限使用我，请联系 Agent 管理者开通');
  assert.equal(renderGroupBlockedNotice(GROUP_BLOCK_REASON.NOT_ENABLED), GROUP_NOT_ENABLED_NOTICE);
  assert.equal(renderGroupBlockedNotice(GROUP_BLOCK_REASON.SENDER_NOT_ALLOWED), GROUP_NO_PERMISSION_NOTICE);
});

test('sendNoticeSafely logs and swallows failed sends and thrown errors', async () => {
  const errors = [];
  const onError = (msg) => errors.push(msg);

  assert.equal(await sendNoticeSafely(async () => ({ ok: false, error: 'nack' }), 'a', onError), false);
  assert.equal(await sendNoticeSafely(async () => { throw new Error('boom'); }, 'b', onError), false);
  assert.equal(await sendNoticeSafely(() => { throw new Error('sync'); }, 'c', onError), false);

  assert.equal(errors.length, 3);
  assert.match(errors[0], /Failed to send a: nack/);
  assert.match(errors[1], /Failed to send b: boom/);
  assert.match(errors[2], /Failed to send c: sync/);
});

test('owner guide text is the fixed Chinese guide', () => {
  assert.equal(
    OWNER_GUIDE_TEXT,
    '你已成为这个 Agent 的管理者。\n'
      + '开启群聊：把我拉进群后，在群里 @我 说「开启本群」。\n'
      + '开放私聊：跟我说「允许所有同事私聊你」，或「允许某某私聊你」。'
  );
});

test('bindOwnerIfUnbound returns false when persisting fails', () => {
  const config = {};
  assert.equal(bindOwnerIfUnbound(config, 'u1', '', () => false), false);
  assert.equal(config.owner.name, 'u1');
});

function makeDeps(config) {
  const replies = [];
  const proactive = [];
  const saves = [];
  const errors = [];
  return {
    replies,
    proactive,
    saves,
    errors,
    deps: {
      sendReply: async (reqId, text) => { replies.push({ reqId, text }); return { ok: true }; },
      sendProactive: async (userId, text) => { proactive.push({ userId, text }); return { ok: true }; },
      bindOwner: (userId, userName) => bindOwnerIfUnbound(config, userId, userName, (cfg) => {
        saves.push(structuredClone(cfg));
        return true;
      }),
      onError: (msg) => errors.push(msg)
    }
  };
}

const groupMsg = (overrides = {}) => ({
  isGroup: true, chatId: 'chatA', userId: 'u1', userName: 'U1', reqId: 'req-1', ...overrides
});
const dmMsg = (overrides = {}) => ({
  isGroup: false, chatId: undefined, userId: 'u1', userName: 'U1', reqId: 'req-dm', ...overrides
});

test('applyAccessGate: blocked group mention (not enabled) -> exactly one reply notice', async () => {
  const config = { owner: OWNER, groupPolicy: 'allowlist', groups: {} };
  const h = makeDeps(config);

  const gate = applyAccessGate({ config, ...groupMsg() }, h.deps);
  await gate.notice;

  assert.equal(gate.allowed, false);
  assert.equal(gate.reason, GROUP_BLOCK_REASON.NOT_ENABLED);
  assert.deepEqual(h.replies, [{ reqId: 'req-1', text: GROUP_NOT_ENABLED_NOTICE }]);
  assert.deepEqual(h.proactive, []);
});

test('applyAccessGate: blocked group mention (sender not allowed) -> no-permission notice', async () => {
  const config = { owner: OWNER, groups: { chatA: { name: 'A', allowFrom: ['u2'] } } };
  const h = makeDeps(config);

  const gate = applyAccessGate({ config, ...groupMsg() }, h.deps);
  await gate.notice;

  assert.equal(gate.allowed, false);
  assert.deepEqual(h.replies, [{ reqId: 'req-1', text: GROUP_NO_PERMISSION_NOTICE }]);
});

test('applyAccessGate: allowed group message -> no notice', async () => {
  const config = { owner: OWNER, groups: { chatA: { name: 'A' } } };
  const h = makeDeps(config);

  const gate = applyAccessGate({ config, ...groupMsg() }, h.deps);
  await gate.notice;
  const ownerGate = applyAccessGate({ config, ...groupMsg({ chatId: 'chatB', userId: 'owner1' }) }, h.deps);
  await ownerGate.notice;

  assert.equal(gate.allowed, true);
  assert.equal(ownerGate.allowed, true);
  assert.equal(gate.notice, null);
  assert.deepEqual(h.replies, []);
  assert.deepEqual(h.proactive, []);
});

test('applyAccessGate: group messages never bind an owner', async () => {
  const config = { groupPolicy: 'open' };
  const h = makeDeps(config);

  const gate = applyAccessGate({ config, ...groupMsg() }, h.deps);
  await gate.notice;

  assert.equal(config.owner, undefined);
  assert.deepEqual(h.proactive, []);
});

test('applyAccessGate: blocked DM -> no notice', async () => {
  const config = { owner: OWNER, dmPolicy: 'owner' };
  const h = makeDeps(config);

  const gate = applyAccessGate({ config, ...dmMsg() }, h.deps);
  await gate.notice;

  assert.equal(gate.allowed, false);
  assert.equal(gate.notice, null);
  assert.deepEqual(h.replies, []);
  assert.deepEqual(h.proactive, []);
});

test('applyAccessGate: first DM binds owner and sends the guide once; later DMs do not', async () => {
  const config = { dmPolicy: 'owner' };
  const h = makeDeps(config);

  const first = applyAccessGate({ config, ...dmMsg({ userId: 'owner1', userName: 'Owner' }) }, h.deps);
  await first.notice;
  const second = applyAccessGate({ config, ...dmMsg({ userId: 'owner1', userName: 'Owner', reqId: 'r2' }) }, h.deps);
  await second.notice;
  const other = applyAccessGate({ config, ...dmMsg({ userId: 'u9', reqId: 'r3' }) }, h.deps);
  await other.notice;

  assert.equal(first.allowed, true);
  assert.equal(first.ownerBound, true);
  assert.equal(second.allowed, true);
  assert.equal(second.ownerBound, false);
  assert.equal(other.allowed, false);
  assert.deepEqual(config.owner, { bound: true, user_id: 'owner1', name: 'Owner' });
  assert.equal(h.saves.length, 1);
  assert.deepEqual(h.proactive, [{ userId: 'owner1', text: OWNER_GUIDE_TEXT }]);
  assert.deepEqual(h.replies, []);
});

test('applyAccessGate: no guide when owner bind is not persisted', async () => {
  const config = {};
  const h = makeDeps(config);
  const deps = { ...h.deps, bindOwner: (userId, userName) => bindOwnerIfUnbound(config, userId, userName, () => false) };

  const gate = applyAccessGate({ config, ...dmMsg() }, deps);
  await gate.notice;

  assert.equal(gate.ownerBound, false);
  assert.deepEqual(h.proactive, []);
});

test('applyAccessGate: notice send failure is logged and swallowed', async () => {
  const config = { groupPolicy: 'disabled' };
  const h = makeDeps(config);
  const deps = { ...h.deps, sendReply: async () => { throw new Error('ws down'); } };

  const gate = applyAccessGate({ config, ...groupMsg() }, deps);
  assert.equal(await gate.notice, false);
  assert.equal(gate.allowed, false);
  assert.equal(h.errors.length, 1);
  assert.match(h.errors[0], /ws down/);
});
