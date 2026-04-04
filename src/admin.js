#!/usr/bin/env node
/**
 * zylos-wecom admin CLI
 * Manage WeCom bot configuration
 *
 * Usage: node admin.js <command> [args]
 */

import { loadConfig, saveConfig, saveCredentialsToEnv } from './lib/config.js';
import { t, renderAdminHelp, describeDmPolicy } from './lib/i18n/cli-messages.js';
import { parseLocaleArg, resolveLocale, stripLocaleArg } from './lib/i18n/locale.js';
import { scanQRCodeForBotInfo } from './lib/scan-onboard.js';

const rawCliArgs = process.argv.slice(2);
const configForLocale = loadConfig();
const locale = resolveLocale({
  cliLocale: parseLocaleArg(rawCliArgs),
  configLocale: configForLocale?.message?.locale,
  envLocale: process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG
});
const cliArgs = stripLocaleArg(rawCliArgs);

function saveConfigOrExit(config) {
  if (saveConfig(config)) return true;
  console.error(t(locale, 'admin_save_failed'));
  process.exit(1);
}

const VALID_GROUP_POLICIES = new Set(['disabled', 'allowlist', 'open']);

// Commands
const commands = {
  'show': () => {
    console.log(JSON.stringify(configForLocale, null, 2));
  },

  'list-groups': () => {
    const config = loadConfig();
    const groups = config.groups || {};
    const entries = Object.entries(groups);

    if (entries.length === 0) {
      console.log(t(locale, 'admin_no_groups'));
      return;
    }

    console.log(t(locale, 'admin_group_policy', { policy: config.groupPolicy || 'allowlist' }));
    console.log(t(locale, 'admin_configured_groups', { count: entries.length }));
    for (const [chatId, cfg] of entries) {
      const mode = cfg.mode || 'mention';
      const allowFrom = cfg.allowFrom?.length ? ` allowFrom: [${cfg.allowFrom.join(', ')}]` : '';
      console.log(t(locale, 'admin_group_entry', {
        chatId,
        name: cfg.name || t(locale, 'admin_unnamed'),
        mode,
        allowFrom
      }));
    }
  },

  'add-group': (chatId, name, mode = 'mention') => {
    if (!chatId || !name) {
      console.error(t(locale, 'admin_usage_add_group'));
      process.exit(1);
    }
    if (!['mention', 'smart'].includes(mode)) {
      console.error(t(locale, 'admin_mode_invalid'));
      process.exit(1);
    }
    const config = loadConfig();
    if (!config.groups) config.groups = {};

    if (config.groups[chatId]) {
      console.log(t(locale, 'admin_group_exists', { chatId, mode }));
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
    console.log(t(locale, 'admin_group_added', { chatId, name, mode }));
    console.log(t(locale, 'admin_restart_hint'));
  },

  'remove-group': (chatId) => {
    if (!chatId) {
      console.error(t(locale, 'admin_usage_remove_group'));
      process.exit(1);
    }
    const config = loadConfig();

    if (config.groups?.[chatId]) {
      const name = config.groups[chatId].name;
      delete config.groups[chatId];
      saveConfigOrExit(config);
      console.log(t(locale, 'admin_group_removed', { chatId, name }));
      console.log(t(locale, 'admin_restart_hint'));
    } else {
      console.log(t(locale, 'admin_group_missing', { chatId }));
    }
  },

  'set-group-policy': (policy) => {
    const normalizedPolicy = String(policy || '').trim().toLowerCase();
    if (!VALID_GROUP_POLICIES.has(normalizedPolicy)) {
      console.error(t(locale, 'admin_invalid_group_policy', { policy: policy || '' }));
      console.error(t(locale, 'admin_usage_set_group_policy'));
      process.exit(1);
    }
    const config = loadConfig();
    config.groupPolicy = normalizedPolicy;
    saveConfigOrExit(config);
    console.log(t(locale, 'admin_group_policy_set', { policy: normalizedPolicy }));
    console.log(t(locale, 'admin_restart_hint'));
  },

  'set-group-allowfrom': (chatId, ...userIds) => {
    const normalizedChatId = String(chatId || '').trim();
    if (!normalizedChatId || userIds.length === 0) {
      console.error(t(locale, 'admin_usage_set_group_allowfrom'));
      process.exit(1);
    }
    const config = loadConfig();
    if (!config.groups?.[normalizedChatId]) {
      console.error(t(locale, 'admin_group_not_configured', { chatId: normalizedChatId }));
      process.exit(1);
    }
    const normalizedUserIds = [...new Set(userIds.map(id => String(id).trim()).filter(Boolean))];
    if (normalizedUserIds.length === 0) {
      console.error(t(locale, 'admin_allowfrom_empty'));
      process.exit(1);
    }
    config.groups[normalizedChatId].allowFrom = normalizedUserIds;
    saveConfigOrExit(config);
    console.log(t(locale, 'admin_allowfrom_set', {
      chatId: normalizedChatId,
      userIds: normalizedUserIds.join(', ')
    }));
    console.log(t(locale, 'admin_restart_hint'));
  },

  'set-dm-policy': (policy) => {
    const valid = ['open', 'allowlist', 'owner'];
    policy = String(policy || '').trim().toLowerCase();
    if (!valid.includes(policy)) {
      console.error(t(locale, 'admin_usage_set_dm_policy'));
      process.exit(1);
    }
    const config = loadConfig();
    config.dmPolicy = policy;
    saveConfigOrExit(config);
    console.log(t(locale, 'admin_dm_policy_set', {
      policy,
      desc: describeDmPolicy(locale, policy)
    }));
    console.log(t(locale, 'admin_restart_hint'));
  },

  'list-dm-allow': () => {
    const config = loadConfig();
    console.log(t(locale, 'admin_dm_policy', { policy: config.dmPolicy || 'owner' }));
    console.log(t(locale, 'admin_group_policy', { policy: config.groupPolicy || 'allowlist' }));
    const allowFrom = config.dmAllowFrom || [];
    console.log(t(locale, 'admin_dm_allowfrom', {
      count: allowFrom.length,
      users: allowFrom.length ? allowFrom.join(', ') : t(locale, 'admin_none')
    }));
  },

  'add-dm-allow': (userId) => {
    if (!userId) {
      console.error(t(locale, 'admin_usage_add_dm_allow'));
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
    console.log(t(locale, 'admin_dm_allow_added', { userId }));
    if ((config.dmPolicy || 'owner') !== 'allowlist') {
      console.log(t(locale, 'admin_dm_policy_note', { policy: config.dmPolicy || 'owner' }));
    }
    console.log(t(locale, 'admin_restart_hint'));
  },

  'remove-dm-allow': (userId) => {
    if (!userId) {
      console.error(t(locale, 'admin_usage_remove_dm_allow'));
      process.exit(1);
    }
    const config = loadConfig();
    if (!Array.isArray(config.dmAllowFrom)) {
      console.log(t(locale, 'admin_no_dm_allowfrom'));
      return;
    }
    const idx = config.dmAllowFrom.indexOf(userId);
    if (idx !== -1) {
      config.dmAllowFrom.splice(idx, 1);
      saveConfigOrExit(config);
      console.log(t(locale, 'admin_dm_allow_removed', { userId }));
    } else {
      console.log(t(locale, 'admin_dm_allow_missing', { userId }));
    }
  },

  'show-owner': () => {
    const config = loadConfig();
    const owner = config.owner || {};
    if (owner.bound) {
      console.log(t(locale, 'admin_owner', { name: owner.name || t(locale, 'admin_unnamed') }));
      console.log(t(locale, 'admin_owner_user_id', { userId: owner.user_id }));
    } else {
      console.log(t(locale, 'admin_no_owner'));
    }
  },

  'scan-onboard': async () => {
    try {
      const { botId, secret } = await scanQRCodeForBotInfo({ locale });
      const path = saveCredentialsToEnv({
        bot_id: botId,
        secret
      });
      console.log(t(locale, 'admin_scan_saved', { path, botId }));
      console.log(t(locale, 'admin_restart_hint'));
    } catch (err) {
      console.error(t(locale, 'admin_scan_failed', { message: err.message }));
      process.exit(1);
    }
  },

  'help': () => {
    console.log(renderAdminHelp(locale));
  }
};

// Main
const command = cliArgs[0] || 'help';

if (commands[command]) {
  await commands[command](...cliArgs.slice(1));
} else {
  console.error(t(locale, 'admin_unknown_command', { command }));
  commands.help();
  process.exit(1);
}
