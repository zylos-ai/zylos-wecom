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
  scan-onboard                        扫码获取 Bot ID/Secret 并回填到现有 .env

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
  scan-onboard                        Scan QR to fetch Bot ID/Secret into the existing .env

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
    admin_scan_saved: '扫码凭证已写入 {path} (Bot ID: {botId})',
    admin_scan_failed: '扫码接入失败: {message}',
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
    send_error: '错误: {message}',
    runtime_owner_bound: 'Owner 已绑定: {userName} ({userId})',
    runtime_reply_via_req: '通过 reqId {reqId} 回复到 {target}',
    runtime_send_proactive: '向 chatId 主动发送: {chatId}',
    runtime_ignore_no_sender: '忽略没有发送者的消息',
    runtime_group_blocked: '来自 {senderName} 的群消息在 {chatId} 被策略拦截',
    runtime_dm_blocked: '来自 {senderName} ({userId}) 的私聊被策略拦截',
    runtime_event_received: '收到事件: {eventType}',
    runtime_authenticated: '认证成功',
    runtime_auth_failed: '认证失败: {frame}',
    runtime_starting: '启动中（WebSocket 模式）...',
    runtime_data_dir: '数据目录: {dir}',
    runtime_disabled_exit: '组件在配置中已禁用，退出。',
    runtime_missing_creds: '错误: 必须在 ~/zylos/.env 中设置 WECOM_BOT_ID 和 WECOM_BOT_SECRET',
    runtime_config_reloaded: '配置已重载',
    runtime_disabled_stopping: '组件已禁用，正在停止...',
    runtime_duplicate_msg: '重复消息 {msgId}，跳过',
    runtime_ws_not_connected: 'WebSocket 未连接，无法发送',
    runtime_ws_send_error: 'WebSocket 发送错误: {message}',
    runtime_message_summary: '{kind} 来自 {senderName}: {content}',
    runtime_kind_group: '群消息',
    runtime_kind_dm: '私聊',
    runtime_connecting: '正在连接到 {url}...',
    runtime_ws_authenticating: 'WebSocket 已连接，正在认证...',
    runtime_callback_error: '回调处理错误: {message}',
    runtime_send_error_body: '发送错误 ({cmd}): {body}',
    runtime_send_error_frame: '发送错误: {frame}',
    runtime_unknown_frame: '未知 frame: {frame}',
    runtime_parse_failed: '消息解析失败: {message}',
    runtime_ws_closed: 'WebSocket 已关闭: {code} {reason}',
    runtime_ws_error: 'WebSocket 错误: {message}',
    runtime_reconnecting: '{seconds} 秒后重连...',
    runtime_internal_request_failed: '内部请求处理失败: {message}',
    runtime_internal_api: '内部 API 监听于 127.0.0.1:{port}',
    runtime_bot_id: 'Bot ID: {botId}',
    runtime_shutting_down: '正在关闭...',
    runtime_internal_server_closed: '内部服务已关闭',
    runtime_force_exit: '超时后强制退出',
    runtime_welcome_locale: '欢迎语按 locale 输出',
    runtime_welcome_fallback: '欢迎语使用 legacy welcome_text 回退',
    config_file_missing: '配置文件不存在: {path}',
    config_load_failed: '加载配置失败: {message}',
    config_save_failed: '保存配置失败: {message}',
    config_watch_missing: 'fs.watch 事件后配置文件缺失，跳过重载',
    config_watch_reloading: '配置文件已变化，正在重载...',
    config_watch_error: '配置 watcher 错误: {message}',
    runtime_uncaught_exception: '未捕获异常: {message}',
    runtime_unhandled_rejection: '未处理的 Promise 拒绝: {reason}',
    scan_fetching_qr: '正在获取企业微信扫码二维码...',
    scan_prompt: '请使用企业微信扫描下方二维码完成机器人绑定：',
    scan_alt_url: '如果终端二维码显示异常，也可打开这个链接扫码：{url}',
    scan_waiting: '等待扫码结果中...',
    scan_success: '扫码成功，Bot ID 和 Secret 已自动获取。',
    scan_timeout: '扫码超时（5 分钟），请重试。',
    scan_http_error: '企业微信扫码接口请求失败，HTTP {status}',
    scan_generate_parse_error: '解析二维码生成响应失败',
    scan_query_parse_error: '解析扫码轮询响应失败',
    scan_generate_missing_fields: '二维码生成成功，但返回里缺少 scode 或 auth_url',
    scan_missing_bot_info: '扫码成功，但没有拿到 Bot ID 或 Secret',
    scan_terminal_status: '扫码流程结束于异常状态: {status}',
    scan_session_missing: '扫码会话不存在或已失效',
    scan_session_mismatch: '扫码会话不匹配，请刷新二维码后重试'
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
    admin_scan_saved: 'Scanned credentials written to {path} (Bot ID: {botId})',
    admin_scan_failed: 'Scan onboarding failed: {message}',
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
    send_error: 'Error: {message}',
    runtime_owner_bound: 'Owner bound: {userName} ({userId})',
    runtime_reply_via_req: 'Replying via reqId {reqId} to {target}',
    runtime_send_proactive: 'Sending proactive to chatId: {chatId}',
    runtime_ignore_no_sender: 'Ignoring message with no sender',
    runtime_group_blocked: 'Group message from {senderName} in {chatId} blocked by policy',
    runtime_dm_blocked: 'DM from {senderName} ({userId}) blocked by policy',
    runtime_event_received: 'Event received: {eventType}',
    runtime_authenticated: 'Authenticated successfully',
    runtime_auth_failed: 'Authentication failed: {frame}',
    runtime_starting: 'Starting (WebSocket mode)...',
    runtime_data_dir: 'Data directory: {dir}',
    runtime_disabled_exit: 'Component disabled in config, exiting.',
    runtime_missing_creds: 'ERROR: WECOM_BOT_ID and WECOM_BOT_SECRET must be set in ~/zylos/.env',
    runtime_config_reloaded: 'Config reloaded',
    runtime_disabled_stopping: 'Component disabled, stopping...',
    runtime_duplicate_msg: 'Duplicate message {msgId}, skipping',
    runtime_ws_not_connected: 'WebSocket not connected, cannot send',
    runtime_ws_send_error: 'WebSocket send error: {message}',
    runtime_message_summary: '{kind} from {senderName}: {content}',
    runtime_kind_group: 'Group',
    runtime_kind_dm: 'DM',
    runtime_connecting: 'Connecting to {url}...',
    runtime_ws_authenticating: 'WebSocket connected, authenticating...',
    runtime_callback_error: 'Callback processing error: {message}',
    runtime_send_error_body: 'Send error ({cmd}): {body}',
    runtime_send_error_frame: 'Send error: {frame}',
    runtime_unknown_frame: 'Unknown frame: {frame}',
    runtime_parse_failed: 'Failed to parse message: {message}',
    runtime_ws_closed: 'WebSocket closed: {code} {reason}',
    runtime_ws_error: 'WebSocket error: {message}',
    runtime_reconnecting: 'Reconnecting in {seconds}s...',
    runtime_internal_request_failed: 'Internal request handling failed: {message}',
    runtime_internal_api: 'Internal API on 127.0.0.1:{port}',
    runtime_bot_id: 'Bot ID: {botId}',
    runtime_shutting_down: 'Shutting down...',
    runtime_internal_server_closed: 'Internal server closed',
    runtime_force_exit: 'Force exit after timeout',
    runtime_welcome_locale: 'Welcome message sent via locale-aware mapping',
    runtime_welcome_fallback: 'Welcome message fell back to legacy welcome_text',
    config_file_missing: 'Config file not found: {path}',
    config_load_failed: 'Failed to load config: {message}',
    config_save_failed: 'Failed to save config: {message}',
    config_watch_missing: 'Config file missing after fs.watch event, skipping reload',
    config_watch_reloading: 'Config file changed, reloading...',
    config_watch_error: 'Config watcher error: {message}',
    runtime_uncaught_exception: 'Uncaught exception: {message}',
    runtime_unhandled_rejection: 'Unhandled rejection: {reason}',
    scan_fetching_qr: 'Fetching WeCom onboarding QR code...',
    scan_prompt: 'Scan the QR code below with WeCom to bind the bot:',
    scan_alt_url: 'If the terminal QR does not render well, open this URL instead: {url}',
    scan_waiting: 'Waiting for scan result...',
    scan_success: 'Scan succeeded. Bot ID and Secret were fetched automatically.',
    scan_timeout: 'Scan timed out after 5 minutes. Please retry.',
    scan_http_error: 'WeCom scan endpoint request failed with HTTP {status}',
    scan_generate_parse_error: 'Failed to parse QR generate response',
    scan_query_parse_error: 'Failed to parse QR polling response',
    scan_generate_missing_fields: 'QR code generation response is missing scode or auth_url',
    scan_missing_bot_info: 'Scan succeeded but Bot ID or Secret was missing',
    scan_terminal_status: 'Scan flow ended in terminal status: {status}',
    scan_session_missing: 'Scan session is missing or has expired',
    scan_session_mismatch: 'Scan session mismatch. Refresh the QR code and try again'
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
