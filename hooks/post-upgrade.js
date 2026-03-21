#!/usr/bin/env node
/**
 * Post-upgrade hook for zylos-wecom
 *
 * Called by Claude after CLI upgrade completes (zylos upgrade --json).
 * CLI handles: stop service, backup, file sync, npm install, manifest.
 *
 * This hook handles component-specific migrations:
 * - Config schema migrations (including v0.1.x -> v0.2.x WebSocket migration)
 * - Data format updates
 *
 * Note: Service restart is handled by Claude after this hook.
 */

import fs from 'fs';
import path from 'path';

const HOME = process.env.HOME;
const DATA_DIR = path.join(HOME, 'zylos/components/wecom');
const configPath = path.join(DATA_DIR, 'config.json');

console.log('[post-upgrade] Running wecom-specific migrations...\n');

// Ensure subdirectories exist
fs.mkdirSync(path.join(DATA_DIR, 'logs'), { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'media'), { recursive: true });

// Config migrations
if (fs.existsSync(configPath)) {
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    let migrated = false;
    const migrations = [];

    // Migration 1: Ensure enabled field
    if (config.enabled === undefined) {
      config.enabled = true;
      migrated = true;
      migrations.push('Added enabled field');
    }

    // Migration 2: Remove old webhook_port (replaced by internal_port)
    if (config.webhook_port !== undefined) {
      delete config.webhook_port;
      migrated = true;
      migrations.push('Removed webhook_port (WebSocket mode)');
    }

    // Migration 3: Ensure internal_port
    if (config.internal_port === undefined) {
      config.internal_port = 4459;
      migrated = true;
      migrations.push('Added internal_port=4459');
    }

    // Migration 4: Remove old bot.agent_id (not used in WebSocket mode)
    if (config.bot) {
      delete config.bot;
      migrated = true;
      migrations.push('Removed bot config (WebSocket mode)');
    }

    // Migration 5: Remove old proxy config (not used in WebSocket mode)
    if (config.proxy) {
      delete config.proxy;
      migrated = true;
      migrations.push('Removed proxy config (WebSocket mode)');
    }

    // Migration 6: Ensure owner structure
    if (!config.owner) {
      config.owner = { bound: false, user_id: '', name: '' };
      migrated = true;
      migrations.push('Added owner structure');
    }

    // Migration 7: Ensure dmPolicy
    if (config.dmPolicy === undefined) {
      config.dmPolicy = 'owner';
      migrated = true;
      migrations.push('Added dmPolicy=owner');
    }

    // Migration 8: Ensure dmAllowFrom
    if (config.dmAllowFrom === undefined) {
      config.dmAllowFrom = [];
      migrated = true;
      migrations.push('Added dmAllowFrom');
    }

    // Migration 9: Ensure groupPolicy
    if (config.groupPolicy === undefined) {
      config.groupPolicy = 'allowlist';
      migrated = true;
      migrations.push('Added groupPolicy=allowlist');
    }

    // Migration 10: Ensure groups map
    if (config.groups === undefined) {
      config.groups = {};
      migrated = true;
      migrations.push('Added groups map');
    }

    // Migration 11: Ensure message settings
    if (!config.message || typeof config.message !== 'object') {
      config.message = { context_messages: 10, welcome_text: '' };
      migrated = true;
      migrations.push('Added message settings');
    } else {
      if (config.message.context_messages === undefined) {
        config.message.context_messages = 10;
        migrated = true;
        migrations.push('Added message.context_messages');
      }
      if (config.message.welcome_text === undefined) {
        config.message.welcome_text = '';
        migrated = true;
        migrations.push('Added message.welcome_text');
      }
      if (config.message.useMarkdownCard !== undefined) {
        delete config.message.useMarkdownCard;
        migrated = true;
        migrations.push('Removed deprecated message.useMarkdownCard');
      }
      if (config.message.useMarkdown !== undefined) {
        delete config.message.useMarkdown;
        migrated = true;
        migrations.push('Removed deprecated message.useMarkdown');
      }
    }

    // Migration 12: Ensure ws settings
    if (!config.ws) {
      config.ws = {
        url: 'wss://openws.work.weixin.qq.com',
        heartbeat_interval: 30000,
        reconnect_initial_delay: 1000,
        reconnect_max_delay: 30000
      };
      migrated = true;
      migrations.push('Added ws settings');
    }

    // Save if migrated
    if (migrated) {
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      console.log('Config migrations applied:');
      migrations.forEach(m => console.log('  - ' + m));
    } else {
      console.log('No config migrations needed.');
    }
  } catch (err) {
    console.error('Config migration failed:', err.message);
    process.exit(1);
  }
} else {
  console.log('No config file found, skipping migrations.');
}

// Check for new env vars
console.log('\nChecking environment variables...');
const envFile = path.join(HOME, 'zylos/.env');
let envContent = '';
try { envContent = fs.readFileSync(envFile, 'utf8'); } catch {}

if (!envContent.includes('WECOM_BOT_ID') || !envContent.includes('WECOM_BOT_SECRET')) {
  console.log('  WARNING: WECOM_BOT_ID and WECOM_BOT_SECRET are required for WebSocket mode.');
  console.log('  Add them to ~/zylos/.env before starting the service.');
  console.log('  (Old WECOM_CORP_* vars are no longer used)');
}

console.log('\n[post-upgrade] Complete!');
