import test from 'node:test';
import assert from 'node:assert/strict';

import { redact, redactString, redactJson, isSensitiveKey, isBulkPayloadKey } from './redact.js';

test('masks sensitive object keys case-insensitively', () => {
  const input = {
    aeskey: 'base64secretkey==',
    secret: 'bot-secret',
    botSecret: 'nested-secret',
    apikey: 'ak-123',
    api_key: 'ak-456',
    access_token: 'at-123',
    refresh_token: 'rt-123',
    token: 'tok-123',
    Authorization: 'Bearer xyz',
    password: 'hunter2',
    keep: 'visible'
  };
  const out = redact(input);

  assert.equal(out.aeskey, '***');
  assert.equal(out.secret, '***');
  assert.equal(out.botSecret, '***');
  assert.equal(out.apikey, '***');
  assert.equal(out.api_key, '***');
  assert.equal(out.access_token, '***');
  assert.equal(out.refresh_token, '***');
  assert.equal(out.token, '***');
  assert.equal(out.Authorization, '***');
  assert.equal(out.password, '***');
  // Non-sensitive keys survive.
  assert.equal(out.keep, 'visible');
});

test('does not mutate the original object', () => {
  const input = { aeskey: 'orig', nested: { token: 'orig-token' } };
  const out = redact(input);
  assert.equal(input.aeskey, 'orig');
  assert.equal(input.nested.token, 'orig-token');
  assert.equal(out.aeskey, '***');
  assert.equal(out.nested.token, '***');
});

test('redacts nested objects and arrays', () => {
  const input = {
    body: {
      file: { url: 'https://x.com/a?sign=abc', aeskey: 'k' },
      items: [{ token: 't1' }, { safe: 'ok' }]
    }
  };
  const out = redact(input);
  assert.equal(out.body.file.aeskey, '***');
  assert.equal(out.body.items[0].token, '***');
  assert.equal(out.body.items[1].safe, 'ok');
});

test('masks signed COS url params while keeping the base url and param names', () => {
  const url =
    'https://wework.qpic.cn/wwpic/file.dat?sign=ABC123&q-signature=DEADBEEF&q-ak=AKID99&apikey=zzz&expires=1699999999';
  const masked = redactString(url);

  // Base URL preserved.
  assert.ok(masked.startsWith('https://wework.qpic.cn/wwpic/file.dat?'));
  // Secret param values masked, names preserved.
  assert.ok(masked.includes('sign=***'));
  assert.ok(masked.includes('q-signature=***'));
  assert.ok(masked.includes('q-ak=***'));
  assert.ok(masked.includes('apikey=***'));
  // Non-secret param survives untouched.
  assert.ok(masked.includes('expires=1699999999'));
  // No secret value leaks.
  assert.ok(!masked.includes('ABC123'));
  assert.ok(!masked.includes('DEADBEEF'));
  assert.ok(!masked.includes('AKID99'));
  assert.ok(!masked.includes('zzz'));
});

test('masks generic secret/token/aeskey named url params', () => {
  const masked = redactString('https://x.com/y?access_token=SEKRET&myaeskey=KEY&other=fine');
  assert.ok(masked.includes('access_token=***'));
  assert.ok(masked.includes('myaeskey=***'));
  assert.ok(masked.includes('other=fine'));
  assert.ok(!masked.includes('SEKRET'));
  assert.ok(!masked.includes('KEY'));
});

test('masks url secrets embedded inside string values during deep redaction', () => {
  const out = redact({ note: 'download at https://cos.example/f?sign=TOPSECRET&x=1' });
  assert.ok(out.note.includes('sign=***'));
  assert.ok(out.note.includes('x=1'));
  assert.ok(!out.note.includes('TOPSECRET'));
});

test('redactJson produces a string with no plaintext secrets', () => {
  const frame = {
    cmd: 'aibot_subscribe',
    body: { bot_id: 'b1', secret: 'super-secret', file: { url: 'https://c?sign=SIG', aeskey: 'AES' } }
  };
  const json = redactJson(frame);
  assert.ok(!json.includes('super-secret'));
  assert.ok(!json.includes('SIG'));
  assert.ok(!json.includes('AES'));
  assert.ok(json.includes('aibot_subscribe'));
});

test('handles circular references without throwing', () => {
  const a = { name: 'a' };
  a.self = a;
  const out = redact(a);
  assert.equal(out.name, 'a');
  assert.equal(out.self, '[Circular]');
});

test('redacts base64 bulk payload keeping only a size summary', () => {
  // The reviewer's exact probe: an outbound aibot_upload_media_chunk frame.
  const frame = {
    cmd: 'aibot_upload_media_chunk',
    body: { base64_data: 'QUJDREVGRw==', aeskey: 'KEY', url: 'https://x?sign=SIG&expires=1' }
  };
  const out = redact(frame);
  // Payload content gone, size summary kept.
  assert.equal(out.body.base64_data, '***(12 base64 chars)');
  assert.ok(!JSON.stringify(out).includes('QUJDREVGRw=='));
  // Sibling secrets still masked as before.
  assert.equal(out.body.aeskey, '***');
  assert.ok(out.body.url.includes('sign=***'));
  assert.ok(out.body.url.includes('expires=1'));
});

test('redactJson never leaks a base64 media chunk payload', () => {
  const bigPayload = 'A'.repeat(50000);
  const json = redactJson({ cmd: 'aibot_upload_media_chunk', body: { chunk_index: 3, base64_data: bigPayload } });
  assert.ok(!json.includes(bigPayload));
  assert.ok(json.includes('***(50000 base64 chars)'));
  // Non-payload metadata stays visible for diagnostics.
  assert.ok(json.includes('chunk_index'));
  assert.ok(json.includes('aibot_upload_media_chunk'));
});

test('bulk payload matching covers common base64 field variants', () => {
  assert.equal(isBulkPayloadKey('base64_data'), true);
  assert.equal(isBulkPayloadKey('image_base64'), true);
  assert.equal(isBulkPayloadKey('Base64'), true);
  assert.equal(isBulkPayloadKey('content'), false);
  assert.equal(isBulkPayloadKey('chunk_index'), false);
});

test('isSensitiveKey matches expected key names', () => {
  assert.equal(isSensitiveKey('aeskey'), true);
  assert.equal(isSensitiveKey('AESKEY'), true);
  assert.equal(isSensitiveKey('access_token'), true);
  assert.equal(isSensitiveKey('chatid'), false);
  assert.equal(isSensitiveKey('content'), false);
});
