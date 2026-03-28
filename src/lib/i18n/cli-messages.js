function interpolate(template, params = {}) {
  return template.replace(/\{(\w+)\}/g, (_, key) => String(params[key] ?? ''));
}

const ADMIN_HELP = {
  'zh-CN': `
zylos-wecom 管理 CLI（WebSocket Bot 模式）

命令：
  show                                显示完整配置

  群管理：
  list-groups                         列出所有已配置群
  add-group <chat_id> <name> [mode]   添加群（mode: mention|smart）
  remove-group <chat_id>              移除群
  set-group-policy <policy>           设置群策略（disabled|allowlist|open）
  set-group-allowfrom <chat_id> <ids> 设置群内允许发送者

  私聊访问控制：
  set-dm-policy <open|allowlist|owner> 设置私聊策略
  list-dm-allow                       显示私聊策略和 allowFrom 列表
  add-dm-allow <user_id>              添加用户到 dmAllowFrom
  remove-dm-allow <user_id>           从 dmAllowFrom 移除用户

  show-owner                          显示当前 owner

权限流：
  私聊：dmPolicy (open|allowlist|owner) + dmAllowFrom
  群聊：groupPolicy -> groups 配置 -> 每群 allowFrom
  Owner 永远绕过所有检查。

修改后请重启机器人：pm2 restart zylos-wecom
`.trim(),
  'en-US': `
zylos-wecom admin CLI (WebSocket Bot mode)

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

Permission flow:
  Private DM: dmPolicy (open|allowlist|owner) + dmAllowFrom
  Group chat: groupPolicy -> groups config -> per-group allowFrom
  Owner always bypasses all checks.

After changes, restart bot: pm2 restart zylos-wecom
`.trim()
};

const MESSAGES = {
  'zh-CN': {
    admin_save_failed: '保存配置失败',
    admin_no_groups: '当前没有配置群聊',
    admin_group_policy: '群策略: {policy}',
    admin_configured_groups: '\n已配置群聊（{count}）：',
    admin_group_entry: '  {chatId} - {name} [{mode}]{allowFrom}',
    admin_unnamed: '未命名',
    admin_usage_add_group: '用法: admin.js add-group <chat_id> <name> [mode=mention|smart]',
    admin_mode_invalid: 'mode 必须是 "mention" 或 "smart"',
    admin_group_exists: '群 {chatId} 已存在，更新 mode 为 {mode}',
    admin_group_added: '已添加群: {chatId} ({name}) [{mode}]',
    admin_restart_hint: '执行: pm2 restart zylos-wecom',
    admin_usage_remove_group: '用法: admin.js remove-group <chat_id>',
    admin_group_removed: '已移除群: {chatId} ({name})',
    admin_group_missing: '未找到群 {chatId}',
    admin_invalid_group_policy: '无效策略 "{policy}"。有效值: disabled, allowlist, open。',
    admin_usage_set_group_policy: '用法: admin.js set-group-policy <disabled|allowlist|open>',
    admin_group_policy_set: '群策略已设置为: {policy}',
    admin_usage_set_group_allowfrom: '用法: admin.js set-group-allowfrom <chat_id> <user_id1> [user_id2] ...',
    admin_group_not_configured: '群 {chatId} 未配置，请先用 add-group 添加。',
    admin_allowfrom_empty: '请至少提供一个非空 user ID 或 "*"。',
    admin_allowfrom_set: '已设置 {chatId} 的 allowFrom: [{userIds}]',
    admin_usage_set_dm_policy: '用法: admin.js set-dm-policy <open|allowlist|owner>',
    admin_dm_policy_set: '私聊策略已设置为: {policy} ({desc})',
    admin_dm_policy: '私聊策略: {policy}',
    admin_dm_allowfrom: 'DM allowFrom ({count}): {users}',
    admin_none: '无',
    admin_usage_add_dm_allow: '用法: admin.js add-dm-allow <user_id>',
    admin_dm_allow_added: '已将 {userId} 添加到 dmAllowFrom',
    admin_dm_policy_note: '注意: 当前 dmPolicy 是 "{policy}"，需改为 "allowlist" 才会生效。',
    admin_usage_remove_dm_allow: '用法: admin.js remove-dm-allow <user_id>',
    admin_no_dm_allowfrom: '当前没有配置 dmAllowFrom',
    admin_dm_allow_removed: '已从 dmAllowFrom 移除 {userId}',
    admin_dm_allow_missing: 'dmAllowFrom 中未找到 {userId}',
    admin_owner: 'Owner: {name}',
    admin_owner_user_id: '  user_id: {userId}',
    admin_no_owner: '当前还没有 owner（第一个私聊用户会自动成为 owner）',
    admin_unknown_command: '未知命令: {command}',
    setup_no_config: '没有找到 WeCom doc MCP 配置。',
    setup_checked: '已检查: {path}',
    setup_already_configured: 'mcporter 中已经配置了 wecom-doc。',
    setup_auth_incomplete_warning: '警告: doc MCP 已配置，但企业微信文档授权还没完成。',
    setup_auth_page: 'authorization_page: {url}',
    setup_bot_id: 'bot_id: {botId}',
    setup_mcporter_missing: '未安装 mcporter，或 mcporter 不在 PATH 中。',
    setup_configured_from: '已从 {source} 配置 wecom-doc',
    setup_auth_required_warning: '警告: doc MCP 配置已存在，但文档调用成功前仍需先完成用户授权。',
    send_usage: '用法: send.js <endpoint_id> <message>',
    send_disabled: '错误: wecom 在配置中已禁用',
    send_sent_chunks: '已发送 {count} 个分片',
    send_success: '消息发送成功',
    send_error: '错误: {message}'
  },
  'en-US': {
    admin_save_failed: 'Failed to save config',
    admin_no_groups: 'No groups configured',
    admin_group_policy: 'Group Policy: {policy}',
    admin_configured_groups: '\nConfigured Groups ({count}):',
    admin_group_entry: '  {chatId} - {name} [{mode}]{allowFrom}',
    admin_unnamed: 'unnamed',
    admin_usage_add_group: 'Usage: admin.js add-group <chat_id> <name> [mode=mention|smart]',
    admin_mode_invalid: 'Mode must be "mention" or "smart"',
    admin_group_exists: 'Group {chatId} already configured, updating mode to {mode}',
    admin_group_added: 'Added group: {chatId} ({name}) [{mode}]',
    admin_restart_hint: 'Run: pm2 restart zylos-wecom',
    admin_usage_remove_group: 'Usage: admin.js remove-group <chat_id>',
    admin_group_removed: 'Removed group: {chatId} ({name})',
    admin_group_missing: 'Group {chatId} not found',
    admin_invalid_group_policy: 'Invalid policy "{policy}". Valid values: disabled, allowlist, open.',
    admin_usage_set_group_policy: 'Usage: admin.js set-group-policy <disabled|allowlist|open>',
    admin_group_policy_set: 'Group policy set to: {policy}',
    admin_usage_set_group_allowfrom: 'Usage: admin.js set-group-allowfrom <chat_id> <user_id1> [user_id2] ...',
    admin_group_not_configured: 'Group {chatId} not configured. Add it first with add-group.',
    admin_allowfrom_empty: 'Provide at least one non-empty user ID or "*".',
    admin_allowfrom_set: 'Set allowFrom for {chatId}: [{userIds}]',
    admin_usage_set_dm_policy: 'Usage: admin.js set-dm-policy <open|allowlist|owner>',
    admin_dm_policy_set: 'DM policy set to: {policy} ({desc})',
    admin_dm_policy: 'DM policy: {policy}',
    admin_dm_allowfrom: 'DM allowFrom ({count}): {users}',
    admin_none: 'none',
    admin_usage_add_dm_allow: 'Usage: admin.js add-dm-allow <user_id>',
    admin_dm_allow_added: 'Added {userId} to dmAllowFrom',
    admin_dm_policy_note: 'Note: dmPolicy is "{policy}", set it to "allowlist" for this to take effect.',
    admin_usage_remove_dm_allow: 'Usage: admin.js remove-dm-allow <user_id>',
    admin_no_dm_allowfrom: 'No dmAllowFrom configured',
    admin_dm_allow_removed: 'Removed {userId} from dmAllowFrom',
    admin_dm_allow_missing: '{userId} not found in dmAllowFrom',
    admin_owner: 'Owner: {name}',
    admin_owner_user_id: '  user_id: {userId}',
    admin_no_owner: 'No owner bound (first private message user will become owner)',
    admin_unknown_command: 'Unknown command: {command}',
    setup_no_config: 'No WeCom doc MCP config found.',
    setup_checked: 'Checked: {path}',
    setup_already_configured: 'wecom-doc is already configured in mcporter.',
    setup_auth_incomplete_warning: 'WARNING: doc MCP is configured, but WeCom document authorization is not complete yet.',
    setup_auth_page: 'authorization_page: {url}',
    setup_bot_id: 'bot_id: {botId}',
    setup_mcporter_missing: 'mcporter is not installed or not in PATH.',
    setup_configured_from: 'Configured wecom-doc from {source}',
    setup_auth_required_warning: 'WARNING: doc MCP config exists, but user authorization is still required before doc calls can succeed.',
    send_usage: 'Usage: send.js <endpoint_id> <message>',
    send_disabled: 'Error: wecom is disabled in config',
    send_sent_chunks: 'Sent {count} chunks',
    send_success: 'Message sent successfully',
    send_error: 'Error: {message}'
  }
};

export function t(locale, key, params = {}) {
  const table = MESSAGES[locale] || MESSAGES['zh-CN'];
  return interpolate(table[key] || key, params);
}

export function renderAdminHelp(locale) {
  return ADMIN_HELP[locale] || ADMIN_HELP['zh-CN'];
}

export function describeDmPolicy(locale, policy) {
  const descriptions = {
    'zh-CN': {
      open: '任何人都可私聊',
      allowlist: '仅 dmAllowFrom 用户可私聊',
      owner: '仅 owner 可私聊'
    },
    'en-US': {
      open: 'Anyone can DM',
      allowlist: 'Only dmAllowFrom users can DM',
      owner: 'Only owner can DM'
    }
  };

  return descriptions[locale]?.[policy] || descriptions['zh-CN'][policy] || policy;
}
