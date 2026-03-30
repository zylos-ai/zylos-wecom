import { resolveLocale } from './locale.js';

export function resolveDocAuthGuideLocale({ cliLocale, configLocale, envLocale } = {}) {
  return resolveLocale({ cliLocale, configLocale, envLocale });
}

function renderMissingConfigGuide(locale, { checkedPaths }) {
  if (locale === 'en-US') {
    return [
      'The WeCom doc MCP config is not available yet.',
      '',
      'Complete these steps first:',
      '1. Keep the zylos-wecom bot online and finish WebSocket authentication',
      '2. Trigger the document capability config fetch again',
      '3. If config is still missing, ask the user to provide the StreamableHttp URL / JSON config',
      '',
      ...checkedPaths.map((checkedPath) => `Checked: ${checkedPath}`)
    ].join('\n');
  }

  return [
    '当前还没有拿到企业微信文档 MCP 配置。',
    '',
    '需要先完成这一步：',
    '1. 让 zylos-wecom 机器人保持在线并完成长连接认证',
    '2. 再次触发文档能力配置拉取',
    '3. 如果仍然没有配置，让用户提供 StreamableHttp URL / JSON 配置',
    '',
    ...checkedPaths.map((checkedPath) => `已检查: ${checkedPath}`)
  ].join('\n');
}

function renderAuthedGuide(locale, { docConfig }) {
  if (locale === 'en-US') {
    return [
      'The bot has already completed WeCom document authorization.',
      '',
      'Standard next steps:',
      '1. Confirm mcporter is configured with wecom-doc',
      '2. Use mcporter to call create_doc / get_doc_content / smartsheet_* tools',
      '',
      `MCP type: ${docConfig.type}`,
      `MCP url: ${docConfig.url}`,
      `Config source: ${docConfig.source}`
    ].join('\n');
  }

  return [
    '当前机器人已经完成企业微信文档授权。',
    '',
    '后续标准流程：',
    '1. 先确认 mcporter 已配置 wecom-doc',
    '2. 再通过 mcporter 调用 create_doc / get_doc_content / smartsheet_* 等工具',
    '',
    `MCP type: ${docConfig.type}`,
    `MCP url: ${docConfig.url}`,
    `配置来源: ${docConfig.source}`
  ].join('\n');
}

function renderAuthPageLine(locale, { docConfig }) {
  if (docConfig.authPageUrl) {
    return locale === 'en-US'
      ? `   Authorization page: ${docConfig.authPageUrl}`
      : `   授权页链接: ${docConfig.authPageUrl}`;
  }

  if (docConfig.botId) {
    return locale === 'en-US'
      ? `   Current botId: ${docConfig.botId}\n   Get the authorization page URL for this bot from WeCom before continuing`
      : `   当前 botId: ${docConfig.botId}\n   需要从企业微信侧拿到这个机器人的授权页链接后再继续`;
  }

  return locale === 'en-US'
    ? '   No authorization page URL or botId is available in the current config. Fetch the doc MCP config again first'
    : '   当前配置里没有授权页链接，也没有 botId，需要先重新拉取 doc MCP 配置';
}

function renderNeedsAuthGuide(locale, { docConfig }) {
  if (locale === 'en-US') {
    return [
      'The last fetched WeCom doc auth snapshot is still incomplete.',
      '',
      'Align with the OpenClaw flow:',
      '1. Keep using the current MCP URL and configure mcporter with it first',
      '2. Open the document authorization page for the current bot if calls still fail',
      renderAuthPageLine(locale, { docConfig }),
      '3. In WeCom, confirm that document capability is authorized for the current bot',
      '4. After authorization completes, retry mcporter list wecom-doc --output json / mcporter call wecom-doc.<tool> directly',
      '',
      'Important: isAuthed=false here is only the last fetched snapshot. It is not a hard gate.',
      'If authorization has already taken effect remotely, the same MCP URL may start working before the local snapshot flips to true.',
      '',
      'If the user has not finished authorization yet, common follow-up symptoms are:',
      '- An MCP URL exists, but calls still fail',
      '- 850001 or a similar insufficient-authorization error is returned',
      '',
      `MCP type: ${docConfig.type}`,
      `MCP url: ${docConfig.url}`,
      `Config source: ${docConfig.source}`
    ].join('\n');
  }

  return [
    '当前拿到的企业微信文档授权状态快照仍然是不完整。',
    '',
    '按 OpenClaw 的行为，对齐后的处理顺序应该是：',
    '1. 先继续使用当前 MCP URL，把 mcporter 配好并直接尝试调用',
    '2. 如果调用仍失败，再打开当前机器人的文档授权页',
    renderAuthPageLine(locale, { docConfig }),
    '3. 在企业微信里确认把文档能力授权给当前机器人',
    '4. 授权完成后，直接重试 mcporter list wecom-doc --output json / mcporter call wecom-doc.<tool>',
    '',
    '要点：这里的 isAuthed=false 只是上一次拉配置时看到的快照，不是硬门槛。',
    '只要远端 MCP 已经放行，同一个 URL 可能在本地状态还没翻成 true 之前就已经能调用成功。',
    '',
    '如果用户没有走完授权，后续常见现象是：',
    '- 有 MCP URL，但调用仍失败',
    '- 返回 850001 或类似授权不足错误',
    '',
    `MCP type: ${docConfig.type}`,
    `MCP url: ${docConfig.url}`,
    `配置来源: ${docConfig.source}`
  ].join('\n');
}

export function renderDocAuthGuide({ locale, docConfig, checkedPaths = [] }) {
  if (!docConfig) {
    return renderMissingConfigGuide(locale, { checkedPaths });
  }

  if (docConfig.isAuthed === true) {
    return renderAuthedGuide(locale, { docConfig });
  }

  return renderNeedsAuthGuide(locale, { docConfig });
}
