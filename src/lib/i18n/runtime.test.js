import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveRuntimeLocale, resolveWelcomeMessage } from './runtime.js';

test('resolveRuntimeLocale prefers config locale over env locale', () => {
  const locale = resolveRuntimeLocale(
    { message: { locale: 'en-US' } },
    { LANG: 'zh_CN.UTF-8' }
  );

  assert.equal(locale, 'en-US');
});

test('resolveWelcomeMessage prefers localized welcome text', () => {
  const result = resolveWelcomeMessage(
    {
      message: {
        locale: 'zh-CN',
        welcome_text: 'legacy',
        welcome_texts: {
          'zh-CN': '你好',
          'en-US': 'hello'
        }
      }
    },
    {}
  );

  assert.deepEqual(result, {
    locale: 'zh-CN',
    text: '你好',
    source: 'localized'
  });
});

test('resolveWelcomeMessage falls back to legacy welcome text', () => {
  const result = resolveWelcomeMessage(
    {
      message: {
        locale: 'en-US',
        welcome_text: 'legacy',
        welcome_texts: {
          'zh-CN': '你好'
        }
      }
    },
    {}
  );

  assert.deepEqual(result, {
    locale: 'en-US',
    text: 'legacy',
    source: 'legacy'
  });
});

test('resolveWelcomeMessage returns none when no welcome text exists', () => {
  const result = resolveWelcomeMessage(
    {
      message: {
        locale: 'en-US',
        welcome_text: '',
        welcome_texts: {}
      }
    },
    {}
  );

  assert.deepEqual(result, {
    locale: 'en-US',
    text: '',
    source: 'none'
  });
});
