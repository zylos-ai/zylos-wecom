import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { isValidSessionGroup, sessionGroupFromEndpoint } from './session-group.js';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/session-group.js');

const MAPPED = [
  ['zhangsan|type:p2p|msg:m1', 'dm-zhangsan'],
  ['Li.Si_01-x|type:p2p|msg:m2', 'dm-Li.Si_01-x'],
  ['li.si@corp|type:p2p|msg:m3', 'dm-li.si:corp'],
  ['wrkSFfCgAAxx|type:group|msg:m4', 'group-wrkSFfCgAAxx'],
  // per-message parts never affect the group
  ['wrkSFfCgAAxx|type:group|msg:other', 'group-wrkSFfCgAAxx'],
  ['zhangsan|msg:m5|type:p2p', 'dm-zhangsan'],
];

const INVALID = [
  '',
  'zhangsan',                       // no type
  'zhangsan|type:single|msg:m1',    // unknown type
  '|type:p2p|msg:m1',               // empty id
  '_x|type:p2p|msg:m1',             // must start with a letter or digit
  'a:b|type:p2p|msg:m1',            // ':' would break reversibility
  'a b|type:group|msg:m1',
  '张三|type:p2p|msg:m1',
  `${'x'.repeat(93)}|type:p2p`,     // 96 chars with the prefix, never truncated
];

test('maps each conversation type to its session group', () => {
  for (const [endpoint, group] of MAPPED) {
    const actual = sessionGroupFromEndpoint(endpoint);
    assert.equal(actual, group, endpoint);
    assert.equal(isValidSessionGroup(actual), true, actual);
  }
});

test('mapping is reversible', () => {
  for (const [endpoint, group] of MAPPED) {
    const [prefix, ...rest] = group.split('-');
    const id = rest.join('-').replace(/:/g, '@');
    assert.equal(id, endpoint.split('|')[0], group);
    assert.equal(prefix, endpoint.includes('type:group') ? 'group' : 'dm');
  }
});

test('invalid endpoints throw instead of falling back to the overall group', () => {
  for (const endpoint of [...INVALID, null, undefined]) {
    assert.throws(() => sessionGroupFromEndpoint(endpoint), Error, String(endpoint));
  }
});

test('isValidSessionGroup matches Core syntax', () => {
  for (const name of ['dm-a', 'group-a:b', 'x'.repeat(95)]) assert.equal(isValidSessionGroup(name), true, name);
  for (const name of ['', '-a', ':a', 'a@b', 'a b', 'x'.repeat(96), null, 42]) {
    assert.equal(isValidSessionGroup(name), false, String(name));
  }
});

test('CLI prints the same group the receiver sends', () => {
  for (const [endpoint, group] of MAPPED) {
    assert.equal(execFileSync(process.execPath, [script, endpoint], { encoding: 'utf8' }), `${group}\n`);
  }
});

test('CLI failure exits 1 with nothing on stdout', () => {
  for (const args of [[], ['a', 'b'], [''], ['zhangsan']]) {
    assert.throws(() => execFileSync(process.execPath, [script, ...args], { stdio: 'pipe' }),
      (err) => err.status === 1 && err.stdout.toString() === '' && err.stderr.toString() !== '');
  }
});
