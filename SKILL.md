---
name: wecom
version: 0.2.0
description: >-
  WeCom (企业微信) communication channel via WebSocket long connection
  (智能机器人长连接模式). No public IP or SSL required. Use when:
  (1) replying to WeCom messages (DM or group),
  (2) sending proactive messages to WeCom users,
  (3) managing DM access control (dmPolicy: open/allowlist/owner, dmAllowFrom list),
  (4) managing group access control (groupPolicy, per-group allowFrom),
  (5) configuring the bot (admin CLI, markdown settings),
  (6) troubleshooting WeCom connection or message delivery issues,
  (7) using the official WeCom CLI for contacts, documents, sheets,
  smart sheets, smart pages, calendar, meetings, todos, disk, email,
  office messages, and media operations.
  Config at ~/zylos/components/wecom/config.json. Service: pm2 zylos-wecom.
type: communication

lifecycle:
  npm: true
  service:
    type: pm2
    name: zylos-wecom
    entry: src/index.js
  data_dir: ~/zylos/components/wecom
  hooks:
    post-install: hooks/post-install.js
    pre-upgrade: hooks/pre-upgrade.js
    post-upgrade: hooks/post-upgrade.js
  preserve:
    - config.json
    - .env
    - data/

upgrade:
  repo: zylos-ai/zylos-wecom
  branch: main

config:
  required:
    - name: WECOM_BOT_ID
      description: "Bot ID (智能机器人 Bot ID, format: aibXXX)"
    - name: WECOM_BOT_SECRET
      description: "Bot Secret (智能机器人 Secret)"
      sensitive: true

next-steps: "BEFORE starting the service: 1) Ensure WECOM_BOT_ID and WECOM_BOT_SECRET are set in ~/zylos/.env. 2) In WeCom client, go to Workbench > Intelligent Robot > Create Robot > API Mode > Long Connection. 3) Copy the Bot ID and Secret to .env. 4) Start the service (pm2 restart zylos-wecom). First DM to the bot will auto-bind the sender as owner."

dependencies:
  - comm-bridge
---

# WeCom

WeCom (企业微信) communication channel for zylos.
Uses WebSocket long connection mode (智能机器人长连接) — no public IP, no SSL, no callback URL needed.

Depends on: comm-bridge (C4 message routing).

## Official WeCom CLI

Use the bundled official CLI skills for WeCom office operations. The modular
CLI skill is authoritative for commands, parameters, safety checks, and output
rules. The Unified skill is an intent router and orchestration reference only.
When the two overlap, follow the modular CLI skill.

1. Read `references/wecom-cli/wecomcli-shared/SKILL.md` before every CLI use.
2. Read the matching domain skill under `references/wecom-cli/` in full.
3. For ambiguous or cross-domain requests, also read
   `references/wecom-unified/SKILL.md`, then return to the modular CLI skill
   before constructing commands.
4. Run CLI arguments as an argv array, never through a shell. Code callers can
   use `src/lib/wecom-cli-bridge.js`.

Supported domains: contacts, document management, online documents, online
sheets, smart sheets, smart pages, calendar, meetings, todos, disk, email,
office messages, and media upload/download.

The communication channel and office messaging are separate paths:

- Replies to incoming Zylos conversations and normal proactive C4 messages
  continue through `scripts/send.js` and the WebSocket service.
- An explicit user request to send an office message through the authorized
  WeCom account uses `wecomcli-message` and its current-session restrictions.
- Code callers must invoke the `message` CLI domain through
  `src/lib/wecom-cli-bridge.js` with intent `explicit-office-message`. The
  bridge rejects the call and emits `WECOM_CLI_ROUTE_VIOLATION` otherwise.
  Never mark a channel reply or normal proactive C4 send with that intent.

This component-level integration policy overrides the vendored Skills only for
CLI lifecycle and authorization. Do not run their generic
`npm install -g @wecom/cli` or blocking `wecom-cli auth init` instructions.
The component install/upgrade hook exclusively owns the pinned CLI binary, and
the managed owner-DM helper below exclusively owns authorization. The vendored
domain commands, parameters, safety checks, and output rules remain
authoritative for office operations.

The CLI keeps a separate encrypted authorization ledger, but it can authorize
the same Bot credentials used by the WebSocket channel. Before any CLI business
operation, run `node scripts/wecom-cli-auth.js --check-channel-bot`. Continue
only when it reports `same_bot_authorized`. Treat `reauthorization_required`
the same as unauthorized even if a stale ledger for another Bot exists, then
use this WeCom-only authorization flow:

1. Authorization may be started only from a private WeCom DM sent by the
   configured owner. Never authorize from a group or for a non-owner. Ask the
   owner to DM the bot when an unauthorized request originates in a group.
2. Run the same-Bot path:
   `node scripts/wecom-cli-auth.js --reuse-channel-bot --endpoint <exact-wecom-reply-endpoint>`.
   It feeds the configured `WECOM_BOT_ID` / `WECOM_BOT_SECRET` to the official
   CLI's manual authorization through a PTY. The Secret never appears in argv,
   environment variables, stdout, stderr, or logs. After authorization, the
   helper requires the official CLI's reported Bot ID to exactly match the
   configured WebSocket Bot before it reports success.
3. The helper atomically consumes the short-lived, one-time provenance record;
   a reconstructed, changed, group, non-owner, expired, or replayed endpoint is
   rejected with `WECOM_ENDPOINT_PROVENANCE_VIOLATION` before any send or CLI
   execution. No QR is generated and no new Bot is created by this same-Bot
   path.
4. Do not run the raw QR authorization command or use an independent office
   Bot. Every business command enforces exact equality with the channel Bot,
   so a different Principal is unsupported and will be rejected.
5. A successful helper result is JSON with `status: "authorized"` and
   `retryOriginalOperation: true`. Retry the original office operation once.
   On expiry or failure, report the helper's safe error and wait for the owner
   to retry; do not loop or route authorization through another channel.

Never expose or copy encrypted CLI credential files, tokens, Bot secrets, or
internal IDs. The component install/upgrade hook owns CLI installation. If the
binary is missing or below the required version during a normal business
request, obtain the required component-change confirmation before installing
or upgrading it. Until a separately enforced office-access policy exists,
execute token-backed CLI office operations only for the configured owner.

## Sending Messages

```bash
# Via C4 bridge (standard path)
node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js "wecom" "<user_id>" "Hello!"
```

Direct send (bypasses C4 logging, for testing only):
```bash
node ~/zylos/.claude/skills/wecom/scripts/send.js <user_id> "Hello!"
```

## Admin CLI

Manage bot configuration via `admin.js`:

```bash
ADM="node ~/zylos/.claude/skills/wecom/src/admin.js"

# General
$ADM show                                    # Show full config
$ADM show-owner                              # Show current owner
$ADM help                                    # Show all commands

# DM Access Control
$ADM set-dm-policy <open|allowlist|owner>     # Set DM policy
$ADM list-dm-allow                            # Show DM policy + allowFrom list
$ADM add-dm-allow <user_id>                   # Add user to dmAllowFrom
$ADM remove-dm-allow <user_id>                # Remove user from dmAllowFrom

# Group Management
$ADM list-groups                              # List all configured groups
$ADM add-group <chat_id> <name>               # Add group
$ADM remove-group <chat_id>                   # Remove a group
$ADM set-group-policy <disabled|allowlist|open>  # Set group policy
```

After changes, restart: `pm2 restart zylos-wecom`

## Config Location

- Config: `~/zylos/components/wecom/config.json`
- Logs: `~/zylos/components/wecom/logs/`
- Media: `~/zylos/components/wecom/media/`

## WeCom Setup

### 1. Create Intelligent Robot

In the WeCom client:

1. Go to **Workbench** (工作台) > **Intelligent Robot** (智能机器人) > **Create Robot**
2. Fill in name, avatar, description
3. Select **API Mode Creation** (API模式创建) — requires admin permissions
4. Select **Long Connection** (使用长连接)
5. Copy the **Bot ID** (format: `aibXXX`) and **Secret**
6. **Secret is shown only once** — save it immediately

### 2. Credentials

Add to `~/zylos/.env`:

```bash
WECOM_BOT_ID=aibxxxxxxxxxxxxxxxx
WECOM_BOT_SECRET=your_bot_secret
```

### 3. Message Types

Supported outgoing: text, markdown, image, file

**Sending media:** prefix the outbound message with the C4 media convention
(same as telegram):

```
[MEDIA:image]/absolute/path/to/picture.png
[MEDIA:file]/absolute/path/to/report.pdf
```

Media is uploaded over the long connection in chunks (≤512KB × ≤100 chunks)
and sent by `media_id`. Size caps: image 10MB, file 20MB (voice 2MB, video
10MB at the protocol level; not yet exposed via send.js). Both send paths
support media: the reply path (`aibot_respond_msg`, within 24h of a
callback) and the proactive path (`aibot_send_msg`). On upload/send failure
the send fails loudly (exit 1) — there is no silent text fallback.

Supported incoming (varies by chat type):

| Type | DM | Group |
|---|---|---|
| text | Yes | Yes (@ only) |
| mixed (text+image) | Yes | Yes (@ only) |
| image (standalone) | Yes | Not pushed |
| file | Yes | Not pushed |
| voice (auto-transcribed) | Yes | Not pushed |
| video | Yes | Not pushed |

**Group chat limitations (WeCom platform-level):**
- WeCom only pushes group messages where the bot is @-mentioned. Non-@ messages are never delivered.
- Only `text` and `mixed` types are pushed in group chats. File, voice, video, and standalone image messages are silently dropped by the server.

When a user asks about other platform quirks — why the bot ignores
someone in a group (visibility scope), why quoted images/files are
invisible, DM vs group differences, external groups, media size/rate
limits — read [references/platform-limitations.md](references/platform-limitations.md)
for the full explanations.

### 4. Group Context

Group messages forwarded to the agent include a `<group-context>` block with
recent history. Because WeCom only delivers @-mentions (see limitations
above), this context can only ever contain earlier @bot messages and the
bot's own replies — it is the bot's conversation thread, **not** the full
group discussion. Its value is continuity: the agent sees what was already
asked and answered in that group instead of treating every mention as a
cold start. History is kept in memory (last `message.context_messages`
entries per chat) and dual-written to per-chat JSONL files under
`history/` in the data directory; after a restart the tail of the file
is replayed on first access, so context survives service restarts.

Inbound C4 delivery state is stored separately in `message-delivery.jsonl`.
The component durably records `pending` before forwarding and records
`delivered` only after C4 accepts the message and channel history is written.
Pending records are retried in order at startup; only delivered `body.msgid`
values are suppressed within the 10-minute retry window. C4 does not currently
provide an inbound idempotency key, so a process exit after C4 acceptance but
before the local delivered marker can cause one observable duplicate forward.
This is an explicit at-least-once boundary, not an exactly-once guarantee.

Since every context entry was already forwarded to the agent when it
arrived, attaching it to every message would be pure duplication during a
live exchange. The block is therefore **idle-gated**: it is attached only
when the chat has been quiet for at least `message.context_idle_minutes`
(default 30) — i.e. when the conversation resumes after a gap, which is
when the agent's own session is likely to have rotated and the recap is
actually needed. Set it to `0` to attach context on every message.

The bot's own replies in the context are labeled with its display name,
resolved in this order:

1. `message.bot_name` in config.json (explicit override)
2. Name auto-learned from incoming group messages: since WeCom only pushes
   messages that mention the bot, a message containing exactly one distinct
   `@name` token necessarily names the bot, wherever the mention sits.
   Persisted to `bot-name.json` in the data directory (survives restarts)
   and re-evaluated on every group message, so renaming the bot in WeCom is
   picked up from the next single-mention message; multi-mention messages
   are skipped as ambiguous.
3. Literal `bot`

Set `message.bot_name` if auto-learning cannot apply (e.g. the bot's display
name contains spaces, which truncates at the first space).

## Owner

First user to send a private message becomes the owner (primary partner).
Owner always bypasses all access checks regardless of policy settings.

## Access Control

### Permission Flow

```json
{
  "dmPolicy": "owner",
  "dmAllowFrom": ["UserId"],
  "groupPolicy": "allowlist",
  "groups": { ... }
}
```

**Private DM (dmPolicy):**
1. Owner? -> always allowed
2. `dmPolicy` = `open`? -> anyone can DM
3. `dmPolicy` = `owner`? -> only owner can DM
4. `dmPolicy` = `allowlist`? -> check `dmAllowFrom` list

**Group message (groupPolicy):**
1. `groupPolicy` = `disabled`? -> all group messages dropped
2. `groupPolicy` = `open`? -> respond to all groups
3. `groupPolicy` = `allowlist`? -> only configured groups

## Service Management

```bash
pm2 status zylos-wecom
pm2 logs zylos-wecom
pm2 restart zylos-wecom
```

## 企业微信文档 MCP（兼容回退）

文档操作优先使用上面的官方 `wecom-cli` 文档、表格、智能表格或智能文档
能力。仅当 CLI 明确不支持所需操作，而现有机器人文档 MCP 支持时，才使用
本兼容路径；不要用 MCP 覆盖或绕过 CLI 的权限和安全约束，也不要直接调用
Wedoc API。

### 使用时机

- 用户要创建企业微信文档
- 用户要创建企业微信智能表格
- 用户要编辑机器人创建的企微文档或智能表格

### 前置检查

#### 1. 检查 mcporter

先确认 `mcporter` 可执行。

若未安装，先征得用户同意后执行：

```bash
npm install -g mcporter
```

#### 2. 检查 wecom-doc MCP 是否已可用

先执行：

```bash
mcporter list wecom-doc --output json
```

如果已经能正常返回 tool 列表，直接进入调用阶段。

如果返回 `server not found`、`unknown server` 或类似错误，按下面顺序找配置：

1. `~/zylos/components/wecom/wecom-mcp-config.json`
2. `~/.openclaw/wecomConfig/config.json`

也可以直接执行仓库里的 bootstrap 脚本：

```bash
node ~/zylos/.claude/skills/wecom/scripts/setup-wecom-doc-mcp.js
```

也可以先用下面这个脚本，把当前账号的授权状态和应该给用户发的话术直接打印出来：

```bash
node ~/zylos/.claude/skills/wecom/scripts/print-wecom-doc-auth-guide.js
```

读取后检查是否存在：

- `mcpConfig.doc.type`
- `mcpConfig.doc.url`
- `mcpConfig.doc.isAuthed`
- `mcpConfig.doc.authPageUrl`
- `mcpConfig.doc.botId`

若存在，执行：

```bash
mcporter config add wecom-doc --type "<type>" --url "<url>"
```

然后再次执行：

```bash
mcporter list wecom-doc --output json
```

#### 3. 自动配置失败时的引导

如果本地没有 `mcpConfig.doc`，说明当前 `zylos-wecom` 还没成功拉到文档 MCP 配置，或者企微侧还没授予文档权限。

此时要明确提示用户：

- 当前机器人还没有完成企业微信文档能力授权
- 需要先让 `zylos-wecom` 连上并成功拿到 doc MCP 配置
- 或者让用户提供 `StreamableHttp URL` / JSON 配置

如果本地已经有 `mcpConfig.doc.url`，但 `isAuthed !== true`，按下面顺序引导用户：

1. 先告诉用户：机器人还没完成“企业微信文档能力授权”，所以现在即使已经拿到 MCP URL，文档调用也可能失败
2. 如果配置里有 `authPageUrl`，直接把这个链接发给用户，让用户在企业微信里打开并完成授权
3. 如果没有 `authPageUrl`，但有 `botId`，明确告诉用户要去拿“当前 botId 对应机器人的文档授权页”后再继续
4. 用户授权完成后，让用户回到当前对话重新发起原始文档 / 智能表格请求
5. 然后重新执行：

```bash
mcporter list wecom-doc --output json
```

或直接继续执行原来的 `mcporter call ...`

如果用户反馈调用报 `850001`，默认按“尚未完成授权”处理，不要直接假设是别的故障。

如果调用文档能力拿到 `850002 no authorization`：

1. 优先从返回里的 `help_message` 提取授权链接（通常含 `str_aibotid=...`），不要自己猜链接。
2. 必须按“授权引导模板”回复用户（见下），不要只回一句“去授权”。
3. 文案里不要输出转义字符（例如 `\n`），要输出正常换行的可读文本。

**授权引导模板（建议直接复用）：**

你现在已连接到企业微信文档服务，但当前机器人还没有“文档/智能表格”使用权限，所以暂时无法打开或编辑文档。

请先完成授权（两种情况）：
- 如果你是该智能机器人的创建者：请在企业微信中打开这个链接完成授权：`<AUTH_URL>`
- 如果你不是创建者：请联系机器人创建者，在企业微信「工作台 -> 智能机器人」里找到该机器人并完成文档权限授权

授权完成后，请直接回复我：`已授权`  
我会立即重试你刚才的文档操作。

其中 `<AUTH_URL>` 规则：
- 有 `help_message` 中的链接时，使用该链接
- 没有 `help_message` 但有 `authPageUrl` 时，使用 `authPageUrl`
- 两者都没有时，不要编造链接；明确告知“请联系创建者从机器人授权页完成授权”

当用户提供 URL 或 JSON 配置后，提取 `url` 并执行：

```bash
mcporter config add wecom-doc --type streamable-http --url "<url>"
```

### 调用规则

- 所有请求必须通过 `mcporter call wecom-doc.<tool> --args '{...}' --output json` 执行
- 先用 `mcporter list wecom-doc --output json` 读取实际 tool 列表，不要硬编码 tool 名称和参数结构
- `create_doc` 返回的 `docid` 要保存在当前会话里，后续编辑操作依赖它
- 如果用户要编辑已有文档，但当前会话里没有机器人创建时返回的 `docid`，直接输出：

> 仅支持对机器人创建的文档进行编辑

### 文档工作流

#### 新建普通文档

1. 调用 `create_doc`，传 `doc_type: 3`
2. 保存返回的 `docid`
3. 如需写内容，调用 `edit_doc_content`

#### 新建智能表格

1. 调用 `create_doc`，传 `doc_type: 10`
2. 保存返回的 `docid`
3. 根据实际 tool 列表继续调用智能表格相关 tool

### 错误处理

- 如果 `mcporter call` 返回 `help_message`，优先提取并使用其中的授权链接/说明，不要忽略
- 如果返回 `850001`，说明仍需用户授权或补配置，按上面的配置引导继续
- 如果返回 `850002 no authorization`，使用上面的“授权引导模板”给用户完整引导，并在最后明确让用户回“已授权”
- 如果返回 `daemon not running` 或 `connection refused`，提示先执行：

```bash
mcporter daemon start
```
