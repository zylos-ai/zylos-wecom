#!/usr/bin/env node

import fs from 'fs';
import os from 'os';
import path from 'path';

const ZYLOS_CONFIG_PATH = path.join(os.homedir(), 'zylos', 'components', 'wecom', 'wecom-mcp-config.json');
const OPENCLAW_CONFIG_PATH = path.join(os.homedir(), '.openclaw', 'wecomConfig', 'config.json');

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function extractDocConfig(payload) {
  const doc = payload?.mcpConfig?.doc;
  if (!doc || typeof doc !== 'object') return null;
  const url = typeof doc.url === 'string' ? doc.url.trim() : '';
  const type = typeof doc.type === 'string' && doc.type.trim() ? doc.type.trim() : 'streamable-http';
  const authPageUrl = typeof doc.authPageUrl === 'string' ? doc.authPageUrl.trim() : '';
  const botId = typeof doc.botId === 'string' ? doc.botId.trim() : '';
  const isAuthed = typeof doc.isAuthed === 'boolean' ? doc.isAuthed : undefined;
  return { url, type, authPageUrl, botId, isAuthed };
}

function resolveDocConfig() {
  const primaryPayload = readJson(ZYLOS_CONFIG_PATH);
  const primary = extractDocConfig(primaryPayload);
  if (primary) return { ...primary, source: ZYLOS_CONFIG_PATH };

  const fallbackPayload = readJson(OPENCLAW_CONFIG_PATH);
  const fallback = extractDocConfig(fallbackPayload);
  if (fallback) return { ...fallback, source: OPENCLAW_CONFIG_PATH };

  return null;
}

const docConfig = resolveDocConfig();

if (!docConfig) {
  console.log('当前还没有拿到企业微信文档 MCP 配置。');
  console.log('');
  console.log('需要先完成这一步：');
  console.log('1. 让 zylos-wecom 机器人保持在线并完成长连接认证');
  console.log('2. 再次触发文档能力配置拉取');
  console.log('3. 如果仍然没有配置，让用户提供 StreamableHttp URL / JSON 配置');
  console.log('');
  console.log(`已检查: ${ZYLOS_CONFIG_PATH}`);
  console.log(`已检查: ${OPENCLAW_CONFIG_PATH}`);
  process.exit(0);
}

if (docConfig.isAuthed === true) {
  console.log('当前机器人已经完成企业微信文档授权。');
  console.log('');
  console.log('后续标准流程：');
  console.log('1. 先确认 mcporter 已配置 wecom-doc');
  console.log('2. 再通过 mcporter 调用 create_doc / get_doc_content / smartsheet_* 等工具');
  console.log('');
  console.log(`MCP type: ${docConfig.type}`);
  console.log(`MCP url: ${docConfig.url}`);
  console.log(`配置来源: ${docConfig.source}`);
  process.exit(0);
}

console.log('当前机器人还没有完成企业微信文档授权。');
console.log('');
console.log('首次使用智能表格 / 企微文档时，先引导用户完成以下步骤：');
console.log('1. 打开当前机器人的文档授权页');
if (docConfig.authPageUrl) {
  console.log(`   授权页链接: ${docConfig.authPageUrl}`);
} else if (docConfig.botId) {
  console.log(`   当前 botId: ${docConfig.botId}`);
  console.log('   需要从企业微信侧拿到这个机器人的授权页链接后再继续');
} else {
  console.log('   当前配置里没有授权页链接，也没有 botId，需要先重新拉取 doc MCP 配置');
}
console.log('2. 在企业微信里确认把文档能力授权给当前机器人');
console.log('3. 授权完成后，回到对话重新发起原来的文档/智能表格请求');
console.log('4. 此时再执行 mcporter list wecom-doc --output json / mcporter call wecom-doc.<tool>');
console.log('');
console.log('如果用户没有走完授权，后续常见现象是：');
console.log('- 有 MCP URL，但调用仍失败');
console.log('- 返回 850001 或类似授权不足错误');
console.log('');
console.log(`MCP type: ${docConfig.type}`);
console.log(`MCP url: ${docConfig.url}`);
console.log(`配置来源: ${docConfig.source}`);
