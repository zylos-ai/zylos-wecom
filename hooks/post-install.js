#!/usr/bin/env node
/**
 * Post-install hook for zylos-wecom
 *
 * Called during installation (both terminal and JSON/Claude modes).
 * Terminal mode (stdio: inherit): runs interactive prompts for config.
 * JSON mode (stdio: pipe): runs silently, skips interactive prompts.
 *
 * This hook handles wecom-specific setup:
 * - Create subdirectories (logs, media)
 * - Create default config.json
 * - Check for environment variables (informational)
 */

import fs from 'fs';
import path from 'path';

const HOME = process.env.HOME;
const DATA_DIR = path.join(HOME, 'zylos/components/wecom');
const ENV_FILE = path.join(HOME, 'zylos/.env');

// Minimal initial config - full defaults are in src/lib/config.js
const INITIAL_CONFIG = {
  enabled: true,
  webhook_port: 3459,
  bot: {
    agent_id: 0
  },
  owner: {
    bound: false,
    user_id: '',
    name: ''
  },
  dmPolicy: 'owner',
  dmAllowFrom: [],
  groupPolicy: 'allowlist',
  groups: {},
  proxy: {
    enabled: false,
    host: '',
    port: 0
  },
  message: {
    context_messages: 10,
    useMarkdownCard: false
  }
};

console.log('[post-install] Running wecom-specific setup...\n');

// 1. Create subdirectories
console.log('Creating subdirectories...');
fs.mkdirSync(path.join(DATA_DIR, 'logs'), { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'media'), { recursive: true });
console.log('  - logs/');
console.log('  - media/');

// 2. Create default config if not exists
const configPath = path.join(DATA_DIR, 'config.json');
if (!fs.existsSync(configPath)) {
  console.log('\nCreating default config.json...');
  fs.writeFileSync(configPath, JSON.stringify(INITIAL_CONFIG, null, 2));
  console.log('  - config.json created');
} else {
  console.log('\nConfig already exists, skipping.');
}

// 3. Check environment variables (informational)
console.log('\nChecking environment variables...');
let envContent = '';
try {
  envContent = fs.readFileSync(ENV_FILE, 'utf8');
} catch (e) {}

const requiredVars = [
  'WECOM_CORP_ID',
  'WECOM_CORP_SECRET',
  'WECOM_AGENT_ID',
  'WECOM_TOKEN',
  'WECOM_ENCODING_AES_KEY'
];

const missing = [];
for (const v of requiredVars) {
  if (!envContent.includes(v)) {
    missing.push(v);
  }
}

if (missing.length > 0) {
  console.log(`  Missing env vars: ${missing.join(', ')}`);
  console.log('  Add them to ~/zylos/.env before starting the service.');
} else {
  console.log('  All required credentials found.');
}

// Read domain from zylos config for webhook URL display
let webhookUrl = 'https://<your-domain>/wecom/webhook';
try {
  const zylosConfig = JSON.parse(fs.readFileSync(path.join(HOME, 'zylos/.zylos/config.json'), 'utf8'));
  if (zylosConfig.domain) {
    const protocol = zylosConfig.protocol || 'https';
    webhookUrl = `${protocol}://${zylosConfig.domain}/wecom/webhook`;
  }
} catch (e) {}

console.log('\n[post-install] Complete!');

console.log('\n========================================');
console.log('  WeCom (企业微信) Setup -- Remaining Steps');
console.log('========================================');
console.log('');
console.log('In the WeCom admin console: work.weixin.qq.com');
console.log('');
console.log('1. Create or select a self-built application (自建应用)');
console.log('2. Note the AgentId and Secret');
console.log('3. In "Receive Messages" (接收消息) settings:');
console.log(`   - Callback URL: ${webhookUrl}`);
console.log('   - Set Token and EncodingAESKey');
console.log('4. Add the following to ~/zylos/.env:');
console.log('   WECOM_CORP_ID=ww...');
console.log('   WECOM_CORP_SECRET=your_secret');
console.log('   WECOM_AGENT_ID=1000002');
console.log('   WECOM_TOKEN=your_token');
console.log('   WECOM_ENCODING_AES_KEY=your_43_char_key');
console.log('');
console.log('First private message to the bot will auto-bind the sender as owner.');
console.log('========================================');
