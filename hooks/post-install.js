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
  internal_port: 4459,
  owner: {
    bound: false,
    user_id: '',
    name: ''
  },
  dmPolicy: 'owner',
  dmAllowFrom: [],
  groupPolicy: 'allowlist',
  groups: {},
  message: {
    context_messages: 10,
    welcome_text: ''
  },
  ws: {
    url: 'wss://openws.work.weixin.qq.com',
    heartbeat_interval: 30000,
    reconnect_initial_delay: 1000,
    reconnect_max_delay: 30000
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
  'WECOM_BOT_ID',
  'WECOM_BOT_SECRET'
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

console.log('\n[post-install] Complete!');

console.log('\n========================================');
console.log('  WeCom (企业微信) Setup -- Remaining Steps');
console.log('========================================');
console.log('');
console.log('In the WeCom client:');
console.log('');
console.log('1. Go to Workbench > Intelligent Robot > Create Robot');
console.log('2. Select API Mode Creation (requires admin)');
console.log('3. Select Long Connection (长连接)');
console.log('4. Copy Bot ID and Secret (Secret shown only once!)');
console.log('5. Add the following to ~/zylos/.env:');
console.log('   WECOM_BOT_ID=aibxxxxxxxxxxxxxxxx');
console.log('   WECOM_BOT_SECRET=your_bot_secret');
console.log('');
console.log('First private message to the bot will auto-bind the sender as owner.');
console.log('========================================');
