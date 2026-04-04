import test from 'node:test';
import assert from 'node:assert/strict';

import { describeDmPolicy, renderAdminHelp, t } from './cli-messages.js';

test('renderAdminHelp returns localized help text', () => {
  assert.match(renderAdminHelp('zh-CN'), /管理 CLI/);
  assert.match(renderAdminHelp('en-US'), /admin CLI/);
  assert.match(renderAdminHelp('zh-CN'), /scan-onboard/);
});

test('describeDmPolicy returns localized descriptions', () => {
  assert.equal(describeDmPolicy('zh-CN', 'owner'), '仅 owner 可私聊');
  assert.equal(describeDmPolicy('en-US', 'owner'), 'Only owner can DM');
});

test('t interpolates localized values', () => {
  assert.equal(
    t('zh-CN', 'send_sent_chunks', { count: 3 }),
    '已发送 3 个分片'
  );
  assert.equal(
    t('en-US', 'setup_checked', { path: '/tmp/a.json' }),
    'Checked: /tmp/a.json'
  );
  assert.equal(
    t('en-US', 'runtime_group_blocked', { senderName: 'Alice', chatId: 'g1' }),
    'Group message from Alice in g1 blocked by policy'
  );
  assert.equal(
    t('zh-CN', 'runtime_reconnecting', { seconds: 5 }),
    '5 秒后重连...'
  );
  assert.equal(
    t('en-US', 'config_watch_reloading'),
    'Config file changed, reloading...'
  );
  assert.equal(
    t('en-US', 'runtime_missing_creds'),
    'ERROR: WECOM_BOT_ID and WECOM_BOT_SECRET must be set in ~/zylos/.env'
  );
});
