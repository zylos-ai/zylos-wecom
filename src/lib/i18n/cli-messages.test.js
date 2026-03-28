import test from 'node:test';
import assert from 'node:assert/strict';

import { describeDmPolicy, renderAdminHelp, t } from './cli-messages.js';

test('renderAdminHelp returns localized help text', () => {
  assert.match(renderAdminHelp('zh-CN'), /管理 CLI/);
  assert.match(renderAdminHelp('en-US'), /admin CLI/);
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
});
