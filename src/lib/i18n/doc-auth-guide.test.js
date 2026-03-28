import test from 'node:test';
import assert from 'node:assert/strict';

import {
  renderDocAuthGuide,
  resolveDocAuthGuideLocale
} from './doc-auth-guide.js';

test('resolveDocAuthGuideLocale prefers cli locale over config and env', () => {
  const locale = resolveDocAuthGuideLocale({
    cliLocale: 'en',
    configLocale: 'zh-CN',
    envLocale: 'zh_CN.UTF-8'
  });

  assert.equal(locale, 'en-US');
});

test('resolveDocAuthGuideLocale falls back to config locale and env aliases', () => {
  assert.equal(
    resolveDocAuthGuideLocale({ configLocale: 'en-US' }),
    'en-US'
  );
  assert.equal(
    resolveDocAuthGuideLocale({ envLocale: 'zh_CN.UTF-8' }),
    'zh-CN'
  );
  assert.equal(
    resolveDocAuthGuideLocale({ envLocale: 'fr_FR.UTF-8' }),
    'zh-CN'
  );
});

test('renderDocAuthGuide renders English unauthenticated guide', () => {
  const output = renderDocAuthGuide({
    locale: 'en-US',
    docConfig: {
      type: 'streamable-http',
      url: 'https://example.test/mcp',
      source: '/tmp/wecom-mcp-config.json',
      authPageUrl: 'https://work.weixin.qq.com/auth',
      isAuthed: false
    }
  });

  assert.match(output, /The bot has not completed WeCom document authorization yet\./);
  assert.match(output, /Authorization page: https:\/\/work\.weixin\.qq\.com\/auth/);
  assert.match(output, /Config source: \/tmp\/wecom-mcp-config\.json/);
});

test('renderDocAuthGuide renders Chinese missing-config guide', () => {
  const output = renderDocAuthGuide({
    locale: 'zh-CN',
    docConfig: null,
    checkedPaths: ['/a.json', '/b.json']
  });

  assert.match(output, /当前还没有拿到企业微信文档 MCP 配置。/);
  assert.match(output, /已检查: \/a\.json/);
  assert.match(output, /已检查: \/b\.json/);
});
