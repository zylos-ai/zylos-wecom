#!/usr/bin/env node
/**
 * zylos-wecom admin CLI
 * Manage WeCom bot configuration
 *
 * Usage: node admin.js <command> [args]
 */

import { loadConfig, saveConfig } from './lib/config.js';

function saveConfigOrExit(config) {
  if (saveConfig(config)) return true;
  console.error('Failed to save config');
  process.exit(1);
}

const VALID_GROUP_POLICIES = new Set(['disabled', 'allowlist', 'open']);

// Commands
const commands = {
  'show': () => {
    const config = loadConfig();
    console.log(JSON.stringify(config, null, 2));
  },

  'list-groups': () => {
    const config = loadConfig();
    const groups = config.groups || {};
    const entries = Object.entries(groups);

    if (entries.length === 0) {
      console.log('No groups configured');
      return;
    }

    console.log(`Group Policy: ${config.groupPolicy || 'allowlist'}`);
    console.log(`\nConfigured Groups (${entries.length}):`);
    for (const [chatId, cfg] of entries) {
      const mode = cfg.mode || 'mention';
      const allowFrom = cfg.allowFrom?.length ? ` allowFrom: [${cfg.allowFrom.join(', ')}]` : '';
      console.log(`  ${chatId} - ${cfg.name || 'unnamed'} [${mode}]${allowFrom}`);
    }
  },

  'add-group': (chatId, name, mode = 'mention') => {
    if (!chatId || !name) {
      console.error('Usage: admin.js add-group <chat_id> <name> [mode=mention|smart]');
      process.exit(1);
    }
    if (!['mention', 'smart'].includes(mode)) {
      console.error('Mode must be "mention" or "smart"');
      process.exit(1);
    }
    const config = loadConfig();
    if (!config.groups) config.groups = {};

    if (config.groups[chatId]) {
      console.log(`Group ${chatId} already configured, updating mode to ${mode}`);
      config.groups[chatId].mode = mode;
      config.groups[chatId].requireMention = mode === 'mention';
    } else {
      config.groups[chatId] = {
        name,
        mode,
        requireMention: mode === 'mention',
        added_at: new Date().toISOString()
      };
    }
    saveConfigOrExit(config);
    console.log(`Added group: ${chatId} (${name}) [${mode}]`);
    console.log('Run: pm2 restart zylos-wecom');
  },

  'remove-group': (chatId) => {
    if (!chatId) {
      console.error('Usage: admin.js remove-group <chat_id>');
      process.exit(1);
    }
    const config = loadConfig();

    if (config.groups?.[chatId]) {
      const name = config.groups[chatId].name;
      delete config.groups[chatId];
      saveConfigOrExit(config);
      console.log(`Removed group: ${chatId} (${name})`);
      console.log('Run: pm2 restart zylos-wecom');
    } else {
      console.log(`Group ${chatId} not found`);
    }
  },

  'set-group-policy': (policy) => {
    const normalizedPolicy = String(policy || '').trim().toLowerCase();
    if (!VALID_GROUP_POLICIES.has(normalizedPolicy)) {
      console.error(`Invalid policy "${policy || ''}". Valid values: disabled, allowlist, open.`);
      console.error('Usage: admin.js set-group-policy <disabled|allowlist|open>');
      process.exit(1);
    }
    const config = loadConfig();
    config.groupPolicy = normalizedPolicy;
    saveConfigOrExit(config);
    console.log(`Group policy set to: ${normalizedPolicy}`);
    console.log('Run: pm2 restart zylos-wecom');
  },

  'set-group-allowfrom': (chatId, ...userIds) => {
    const normalizedChatId = String(chatId || '').trim();
    if (!normalizedChatId || userIds.length === 0) {
      console.error('Usage: admin.js set-group-allowfrom <chat_id> <user_id1> [user_id2] ...');
      process.exit(1);
    }
    const config = loadConfig();
    if (!config.groups?.[normalizedChatId]) {
      console.error(`Group ${normalizedChatId} not configured. Add it first with add-group.`);
      process.exit(1);
    }
    const normalizedUserIds = [...new Set(userIds.map(id => String(id).trim()).filter(Boolean))];
    if (normalizedUserIds.length === 0) {
      console.error('Provide at least one non-empty user ID or "*".');
      process.exit(1);
    }
    config.groups[normalizedChatId].allowFrom = normalizedUserIds;
    saveConfigOrExit(config);
    console.log(`Set allowFrom for ${normalizedChatId}: [${normalizedUserIds.join(', ')}]`);
    console.log('Run: pm2 restart zylos-wecom');
  },

  'set-dm-policy': (policy) => {
    const valid = ['open', 'allowlist', 'owner'];
    policy = String(policy || '').trim().toLowerCase();
    if (!valid.includes(policy)) {
      console.error(`Usage: admin.js set-dm-policy <${valid.join('|')}>`);
      process.exit(1);
    }
    const config = loadConfig();
    config.dmPolicy = policy;
    saveConfigOrExit(config);
    const desc = { open: 'Anyone can DM', allowlist: 'Only dmAllowFrom users can DM', owner: 'Only owner can DM' };
    console.log(`DM policy set to: ${policy} (${desc[policy]})`);
    console.log('Run: pm2 restart zylos-wecom');
  },

  'list-dm-allow': () => {
    const config = loadConfig();
    console.log(`DM policy: ${config.dmPolicy || 'owner'}`);
    console.log(`Group policy: ${config.groupPolicy || 'allowlist'}`);
    const allowFrom = config.dmAllowFrom || [];
    console.log(`DM allowFrom (${allowFrom.length}):`, allowFrom.length ? allowFrom.join(', ') : 'none');
  },

  'add-dm-allow': (userId) => {
    if (!userId) {
      console.error('Usage: admin.js add-dm-allow <user_id>');
      process.exit(1);
    }
    const config = loadConfig();
    if (!Array.isArray(config.dmAllowFrom)) {
      config.dmAllowFrom = [];
    }
    if (!config.dmAllowFrom.includes(userId)) {
      config.dmAllowFrom.push(userId);
    }
    saveConfigOrExit(config);
    console.log(`Added ${userId} to dmAllowFrom`);
    if ((config.dmPolicy || 'owner') !== 'allowlist') {
      console.log(`Note: dmPolicy is "${config.dmPolicy || 'owner'}", set to "allowlist" for this to take effect.`);
    }
    console.log('Run: pm2 restart zylos-wecom');
  },

  'remove-dm-allow': (userId) => {
    if (!userId) {
      console.error('Usage: admin.js remove-dm-allow <user_id>');
      process.exit(1);
    }
    const config = loadConfig();
    if (!Array.isArray(config.dmAllowFrom)) {
      console.log('No dmAllowFrom configured');
      return;
    }
    const idx = config.dmAllowFrom.indexOf(userId);
    if (idx !== -1) {
      config.dmAllowFrom.splice(idx, 1);
      saveConfigOrExit(config);
      console.log(`Removed ${userId} from dmAllowFrom`);
    } else {
      console.log(`${userId} not found in dmAllowFrom`);
    }
  },

  'show-owner': () => {
    const config = loadConfig();
    const owner = config.owner || {};
    if (owner.bound) {
      console.log(`Owner: ${owner.name || 'unknown'}`);
      console.log(`  user_id: ${owner.user_id}`);
    } else {
      console.log('No owner bound (first private message user will become owner)');
    }
  },

  'set-markdown': (value) => {
    value = String(value || '').trim().toLowerCase();
    if (!['on', 'off', 'true', 'false'].includes(value)) {
      console.error('Usage: admin.js set-markdown <on|off>');
      process.exit(1);
    }
    const enabled = value === 'on' || value === 'true';
    const config = loadConfig();
    if (!config.message) config.message = {};
    config.message.useMarkdownCard = enabled;
    saveConfigOrExit(config);
    console.log(`Markdown messages: ${enabled ? 'ON' : 'OFF'}`);
    console.log('Config hot-reloads, no restart needed.');
  },

  'help': () => {
    console.log(`
zylos-wecom admin CLI

Commands:
  show                                Show full config

  Group Management:
  list-groups                         List all configured groups
  add-group <chat_id> <name> [mode]   Add a group (mode: mention|smart)
  remove-group <chat_id>              Remove a group
  set-group-policy <policy>           Set group policy (disabled|allowlist|open)
  set-group-allowfrom <chat_id> <ids> Set per-group allowed senders

  DM Access Control:
  set-dm-policy <open|allowlist|owner> Set DM policy
  list-dm-allow                       Show DM policy and allowFrom list
  add-dm-allow <user_id>              Add user to dmAllowFrom
  remove-dm-allow <user_id>           Remove user from dmAllowFrom

  show-owner                          Show current owner

  Message Settings:
  set-markdown <on|off>               Toggle markdown message rendering

Permission flow:
  Private DM:  dmPolicy (open|allowlist|owner) + dmAllowFrom
  Group chat:  groupPolicy -> groups config -> per-group allowFrom
  Owner always bypasses all checks.

After changes, restart bot: pm2 restart zylos-wecom
`);
  }
};

// Main
const args = process.argv.slice(2);
const command = args[0] || 'help';

if (commands[command]) {
  commands[command](...args.slice(1));
} else {
  console.error(`Unknown command: ${command}`);
  commands.help();
  process.exit(1);
}
