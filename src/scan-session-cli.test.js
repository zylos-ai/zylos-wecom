import test from 'node:test';
import assert from 'node:assert/strict';

import { ensureWecomRuntimeRunning, parseLocale } from './scan-session-cli.js';

test('parseLocale respects explicit english locale flags', () => {
  assert.equal(parseLocale(['node', 'cli', '--locale', 'en-US']), 'en-US');
  assert.equal(parseLocale(['node', 'cli'], { LANG: 'en_US.UTF-8' }), 'en-US');
  assert.equal(parseLocale(['node', 'cli'], { LANG: 'zh_CN.UTF-8' }), 'zh-CN');
});

test('ensureWecomRuntimeRunning restarts an existing PM2 service', async () => {
  const calls = [];
  const exec = async (cmd, args) => {
    calls.push([cmd, args]);
    return { stdout: '', stderr: '' };
  };

  await ensureWecomRuntimeRunning(exec, { HOME: '/tmp/zylos-home' });

  assert.deepEqual(calls, [
    ['pm2', ['restart', 'zylos-wecom']],
    ['pm2', ['save']]
  ]);
});

test('ensureWecomRuntimeRunning starts from ecosystem when PM2 service was deleted', async () => {
  const calls = [];
  const exec = async (cmd, args) => {
    calls.push([cmd, args]);
    if (calls.length === 1) {
      const error = new Error('restart failed');
      error.stderr = '[PM2][ERROR] Process or Namespace zylos-wecom not found';
      throw error;
    }
    return { stdout: '', stderr: '' };
  };

  await ensureWecomRuntimeRunning(exec, { HOME: '/tmp/zylos-home' });

  assert.deepEqual(calls, [
    ['pm2', ['restart', 'zylos-wecom']],
    ['pm2', ['start', '/tmp/zylos-home/zylos/.claude/skills/wecom/ecosystem.config.cjs', '--only', 'zylos-wecom']],
    ['pm2', ['save']]
  ]);
});
