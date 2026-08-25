import test from 'node:test';
import assert from 'node:assert/strict';

import { parseQuote, quotedMediaLabel, resolveQuote } from './quote-media.js';

test('extracts downloadable file quote (group reply-to-file path)', () => {
  const quote = {
    msgtype: 'file',
    file: {
      url: 'https://wework.qpic.cn/f.dat?sign=abc&q-signature=def',
      aeskey: 'base64aeskey==',
      filename: 'report.pdf'
    }
  };
  const { placeholder, media } = parseQuote(quote);

  // Chooses to download: media carries the real url + aeskey (not discarded).
  assert.ok(media, 'expected a downloadable media descriptor');
  assert.equal(media.type, 'file');
  assert.equal(media.url, quote.file.url);
  assert.equal(media.aesKey, 'base64aeskey==');
  assert.equal(media.filename, 'report.pdf');
  // Placeholder is the pre-download fallback.
  assert.equal(placeholder, '[file: report.pdf]');
});

test('extracts downloadable image quote', () => {
  const quote = {
    msgtype: 'image',
    image: { url: 'https://cos/img.jpg?sign=xyz', aeskey: 'k==' }
  };
  const { media } = parseQuote(quote);
  assert.ok(media);
  assert.equal(media.type, 'image');
  assert.equal(media.url, quote.image.url);
  assert.equal(media.aesKey, 'k==');
});

test('text quote is extracted as content with no download', () => {
  const { placeholder, media } = parseQuote({ msgtype: 'text', text: { content: 'hello there' } });
  assert.equal(placeholder, 'hello there');
  assert.equal(media, null);
});

test('file quote without url falls back to placeholder (no download)', () => {
  const { placeholder, media } = parseQuote({ msgtype: 'file', file: { filename: 'x.zip' } });
  assert.equal(media, null);
  assert.equal(placeholder, '[file: x.zip]');
});

test('image quote without url falls back to placeholder (no download)', () => {
  const { placeholder, media } = parseQuote({ msgtype: 'image', image: {} });
  assert.equal(media, null);
  assert.equal(placeholder, '[image]');
});

test('voice and video quotes keep placeholder and are never downloaded', () => {
  assert.deepEqual(parseQuote({ msgtype: 'voice' }), { placeholder: '[voice message]', media: null });
  assert.deepEqual(parseQuote({ msgtype: 'video' }), { placeholder: '[video message]', media: null });
});

test('mixed quote joins parts and does not download', () => {
  const quote = {
    msgtype: 'mixed',
    mixed: { msg_item: [{ msgtype: 'text', text: { content: 'see' } }, { msgtype: 'image' }] }
  };
  const { placeholder, media } = parseQuote(quote);
  assert.equal(placeholder, 'see [image]');
  assert.equal(media, null);
});

test('empty/absent quote returns empty placeholder', () => {
  assert.deepEqual(parseQuote(null), { placeholder: '', media: null });
  assert.deepEqual(parseQuote(undefined), { placeholder: '', media: null });
});

test('quotedMediaLabel produces informative labels', () => {
  assert.equal(quotedMediaLabel('file', 'report.pdf'), '[quoted file: report.pdf]');
  assert.equal(quotedMediaLabel('image', 'photo.jpg'), '[quoted image: photo.jpg]');
  assert.equal(quotedMediaLabel('file', ''), '[quoted file: unknown]');
});

test('resolveQuote downloads a quoted file and forwards its media path', async () => {
  const calls = [];
  const quote = {
    msgtype: 'file',
    file: { url: 'https://cos/f.pdf?sign=abc', aeskey: 'k==', filename: 'report.pdf' }
  };
  const result = await resolveQuote(quote, {
    ownMediaPath: '',
    download: (media) => {
      calls.push(media);
      return Promise.resolve({ path: '/data/media/report_123.pdf', filename: 'report.pdf' });
    }
  });

  // A download call was made with the extracted url + aeskey.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, quote.file.url);
  assert.equal(calls[0].aesKey, 'k==');
  // The forwarded message carries the downloaded media path + informative text.
  assert.equal(result.mediaPath, '/data/media/report_123.pdf');
  assert.equal(result.quotedContent, '[quoted file: report.pdf]');
});

test('resolveQuote does not overwrite media the message already carries', async () => {
  const quote = { msgtype: 'image', image: { url: 'https://cos/i.jpg?sign=x', aeskey: 'k' } };
  const result = await resolveQuote(quote, {
    ownMediaPath: '/data/media/own.jpg',
    download: () => Promise.resolve({ path: '/data/media/quoted.jpg', filename: 'quoted.jpg' })
  });
  // Own media wins the mediaPath slot; quoted text still becomes informative.
  assert.equal(result.mediaPath, '/data/media/own.jpg');
  assert.equal(result.quotedContent, '[quoted image: quoted.jpg]');
});

test('resolveQuote falls back to placeholder on download failure', async () => {
  const errors = [];
  const quote = { msgtype: 'file', file: { url: 'https://cos/f?sign=x', aeskey: 'k', filename: 'a.bin' } };
  const result = await resolveQuote(quote, {
    download: () => Promise.reject(new Error('HTTP 403')),
    onError: (media, err) => errors.push(err.message)
  });
  assert.equal(result.mediaPath, '');
  assert.equal(result.quotedContent, '[file: a.bin]');
  assert.deepEqual(errors, ['HTTP 403']);
});

test('resolveQuote never downloads a text quote', async () => {
  let called = false;
  const result = await resolveQuote({ msgtype: 'text', text: { content: 'hi' } }, {
    download: () => { called = true; return Promise.resolve(null); }
  });
  assert.equal(called, false);
  assert.equal(result.quotedContent, 'hi');
  assert.equal(result.mediaPath, '');
});
