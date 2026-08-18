import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseWecomCliError,
  runWecomCli,
  WecomCliAuthRequiredError
} from './wecom-cli-bridge.js';

test('parseWecomCliError reads a structured error after diagnostics', () => {
  const result = parseWecomCliError(`warning: cache expired
{"error":{"type":"AuthError","code":893201,"message":"need auth"}}`);
  assert.deepEqual(result, {
    type: 'AuthError',
    code: 893201,
    message: 'need auth'
  });
});

test('parseWecomCliError ignores malformed and successful output', () => {
  assert.equal(parseWecomCliError(''), null);
  assert.equal(parseWecomCliError('{broken'), null);
  assert.equal(parseWecomCliError('{"results":[]}'), null);
});

test('parseWecomCliError tolerates diagnostics after compact JSON', () => {
  const result = parseWecomCliError(`{"error":{"type":"AuthError","code":893201}}
warning: token cache unavailable`);
  assert.equal(result.code, 893201);
});

test('runWecomCli passes argv without a shell', () => {
  let invocation;
  const output = runWecomCli(['contact', 'search', '--keyword', 'Alice; rm -rf /'], {
    exec(command, args, options) {
      invocation = { command, args, options };
      return '{"results":[]}';
    }
  });

  assert.equal(output, '{"results":[]}');
  assert.equal(invocation.command, 'wecom-cli');
  assert.deepEqual(invocation.args, [
    'contact',
    'search',
    '--keyword',
    'Alice; rm -rf /'
  ]);
  assert.equal(invocation.options.shell, undefined);
});

test('runWecomCli converts authorization failures to a typed error', () => {
  const original = Object.assign(new Error('exit 1'), {
    stdout: '{"error":{"type":"AuthError","code":893201}}',
    stderr: ''
  });

  assert.throws(
    () => runWecomCli(['contact', 'search'], { exec() { throw original; } }),
    (error) => {
      assert.ok(error instanceof WecomCliAuthRequiredError);
      assert.equal(error.errorInfo.code, 893201);
      assert.equal(error.originalError, original);
      return true;
    }
  );
});

test('runWecomCli preserves non-auth failures', () => {
  const original = Object.assign(new Error('exit 1'), {
    stdout: '{"error":{"type":"ApiError","code":500}}',
    stderr: ''
  });
  assert.throws(
    () => runWecomCli(['disk', 'search'], { exec() { throw original; } }),
    (error) => error === original
  );
});
