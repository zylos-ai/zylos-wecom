---
name: wecom
version: 0.1.3
description: >-
  WeCom (企业微信) communication channel via WebSocket long connection
  (智能机器人长连接模式). No public IP or SSL required. Use when:
  (1) replying to WeCom messages (DM or group),
  (2) sending proactive messages to WeCom users,
  (3) managing DM access control (dmPolicy: open/allowlist/owner, dmAllowFrom list),
  (4) managing group access control (groupPolicy, per-group allowFrom),
  (5) configuring the bot (admin CLI, markdown settings),
  (6) troubleshooting WeCom connection or message delivery issues.
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
$ADM add-group <chat_id> <name> [mode]        # Add group (mode: mention|smart)
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

Supported incoming: text, image, voice (auto-transcribed), video, file, mixed
Supported outgoing: text, markdown

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

## 企业微信文档 MCP

这个 skill 只负责通过 `mcporter` 调用企业微信文档 MCP，不要直接调用 Wedoc API。

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
