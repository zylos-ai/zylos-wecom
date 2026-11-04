import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GROUP_BLOCK_REASON,
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

test('blocked group mention sends exactly one notice via reply', async () => {
  const sent = [];
  const sendReply = async (reqId, text) => {
    sent.push({ reqId, text });
    return { ok: true };
  };
  const access = evaluateGroupAccess({ groupPolicy: 'allowlist', groups: {} }, 'chatA', 'u1');
  assert.equal(access.allowed, false);

  const ok = await sendNoticeSafely(() => sendReply('req-1', renderGroupBlockedNotice(access.reason)), 'notice');

  assert.equal(ok, true);
  assert.deepEqual(sent, [{ reqId: 'req-1', text: GROUP_NOT_ENABLED_NOTICE }]);
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

test('owner guide is sent once on bind, not on later DMs', async () => {
  const config = { dmPolicy: 'owner' };
  const saved = [];
  const save = (cfg) => { saved.push(structuredClone(cfg)); return true; };
  const guides = [];
  const sendProactive = async (target, text) => { guides.push({ target, text }); return { ok: true }; };

  const handleDm = async (userId, name) => {
    if (!config.owner?.bound && bindOwnerIfUnbound(config, userId, name, save)) {
      await sendNoticeSafely(() => sendProactive(userId, OWNER_GUIDE_TEXT), 'guide');
    }
  };

  await handleDm('owner1', 'Owner');
  await handleDm('owner1', 'Owner');
  await handleDm('someone', 'Someone');

  assert.deepEqual(config.owner, { bound: true, user_id: 'owner1', name: 'Owner' });
  assert.equal(saved.length, 1);
  assert.deepEqual(guides, [{ target: 'owner1', text: OWNER_GUIDE_TEXT }]);
});

test('bindOwnerIfUnbound returns false when persisting fails', () => {
  const config = {};
  assert.equal(bindOwnerIfUnbound(config, 'u1', '', () => false), false);
  assert.equal(config.owner.name, 'u1');
});
