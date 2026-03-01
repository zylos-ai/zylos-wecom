#!/usr/bin/env node
/**
 * Post-upgrade hook for zylos-wecom
 *
 * Called by Claude after CLI upgrade completes (zylos upgrade --json).
 * CLI handles: stop service, backup, file sync, npm install, manifest.
 *
 * This hook handles component-specific migrations:
 * - Config schema migrations
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

    // Migration 2: Ensure webhook_port
    if (config.webhook_port === undefined) {
      config.webhook_port = 3459;
      migrated = true;
      migrations.push('Added webhook_port');
    }

    // Migration 3: Ensure bot settings
    if (!config.bot) {
      config.bot = { agent_id: 0 };
      migrated = true;
      migrations.push('Added bot settings');
    }

    // Migration 4: Ensure owner structure
    if (!config.owner) {
      config.owner = { bound: false, user_id: '', name: '' };
      migrated = true;
      migrations.push('Added owner structure');
    }

    // Migration 5: Ensure dmPolicy
    if (config.dmPolicy === undefined) {
      config.dmPolicy = 'owner';
      migrated = true;
      migrations.push('Added dmPolicy=owner');
    }

    // Migration 6: Ensure dmAllowFrom
    if (config.dmAllowFrom === undefined) {
      config.dmAllowFrom = [];
      migrated = true;
      migrations.push('Added dmAllowFrom');
    }

    // Migration 7: Ensure groupPolicy
    if (config.groupPolicy === undefined) {
      config.groupPolicy = 'allowlist';
      migrated = true;
      migrations.push('Added groupPolicy=allowlist');
    }

    // Migration 8: Ensure groups map
    if (config.groups === undefined) {
      config.groups = {};
      migrated = true;
      migrations.push('Added groups map');
    }

    // Migration 9: Ensure proxy settings
    if (!config.proxy) {
      config.proxy = { enabled: false, host: '', port: 0 };
      migrated = true;
      migrations.push('Added proxy settings');
    }

    // Migration 10: Ensure message settings
    if (!config.message) {
      config.message = { context_messages: 10, useMarkdownCard: false };
      migrated = true;
      migrations.push('Added message settings');
    } else {
      if (config.message.context_messages === undefined) {
        config.message.context_messages = 10;
        migrated = true;
        migrations.push('Added message.context_messages');
      }
      if (config.message.useMarkdownCard === undefined) {
        config.message.useMarkdownCard = false;
        migrated = true;
        migrations.push('Added message.useMarkdownCard');
      }
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

console.log('\n[post-upgrade] Complete!');
