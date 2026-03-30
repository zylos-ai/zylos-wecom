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

  assert.match(output, /The last fetched WeCom doc auth snapshot is still incomplete\./);
  assert.match(output, /Keep using the current MCP URL and configure mcporter with it first/);
  assert.match(output, /Authorization page: https:\/\/work\.weixin\.qq\.com\/auth/);
  assert.match(output, /isAuthed=false here is only the last fetched snapshot/);
  assert.match(output, /Config source: \/tmp\/wecom-mcp-config\.json/);
});

test('renderDocAuthGuide renders Chinese incomplete-auth guide as retry-first flow', () => {
  const output = renderDocAuthGuide({
    locale: 'zh-CN',
    docConfig: {
      type: 'streamable-http',
      url: 'https://example.test/mcp',
      source: '/tmp/wecom-mcp-config.json',
      botId: 'aib9_example',
      isAuthed: false
    }
  });

  assert.match(output, /当前拿到的企业微信文档授权状态快照仍然是不完整。/);
  assert.match(output, /先继续使用当前 MCP URL，把 mcporter 配好并直接尝试调用/);
  assert.match(output, /isAuthed=false 只是上一次拉配置时看到的快照/);
  assert.match(output, /当前 botId: aib9_example/);
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
