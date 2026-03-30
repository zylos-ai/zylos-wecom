<p align="center">
  <strong>zylos-wecom</strong>
</p>

<p align="center">
  WeCom (企业微信) communication channel for <a href="https://github.com/zylos-ai">Zylos</a> AI agents
</p>

<p align="center">
  <a href="https://github.com/zylos-ai/zylos-wecom/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg" alt="Node.js"></a>
  <a href="https://work.weixin.qq.com"><img src="https://img.shields.io/badge/WeCom-企业微信-07C160.svg" alt="WeCom"></a>
</p>

---

## Features

- **WebSocket Long Connection** -- Connects via WeCom Intelligent Robot (智能机器人) WebSocket protocol
- **No Public IP Needed** -- Outbound WebSocket connection, no callback URL or SSL required
- **Simple Credentials** -- Only Bot ID + Secret (2 values, no corp secret / token / AES key)
- **Message Types** -- Text and markdown sending; text, image, voice, video, file receiving
- **Access Control** -- DM policy (open/allowlist/owner) and group policy with per-group configuration
- **Owner Auto-Binding** -- First private message sender becomes the owner
- **Context Tracking** -- In-memory chat history for contextual conversations
- **Auto Reconnect** -- Exponential backoff with jitter on connection loss
- **C4 Bridge** -- Standard Zylos communication bridge integration
- **Admin CLI** -- Configuration management without manual JSON editing
- **Hot Reload** -- Config changes take effect without restart (most settings)
- **Doc MCP Bootstrap** -- Best-effort fetch and persistence of WeCom doc MCP config after WS auth

## Prerequisites

- Node.js >= 20.0.0
- A WeCom (企业微信) enterprise account
- Admin access to create an Intelligent Robot (智能机器人)

## Quick Start

### 1. Install

```bash
# Via Zylos CLI
zylos add wecom

# Or manually
git clone https://github.com/zylos-ai/zylos-wecom.git ~/zylos/.claude/skills/wecom
cd ~/zylos/.claude/skills/wecom
npm install
node hooks/post-install.js
```

### 2. Create Robot in WeCom

1. Open WeCom client > Workbench > Intelligent Robot > Create Robot
2. Select **API Mode Creation** (requires admin)
3. Select **Long Connection** (长连接)
4. Copy the **Bot ID** (format: `aibXXX`) and **Secret**
5. Secret is shown only once -- save it immediately

### 3. Configure Credentials

Add to `~/zylos/.env`:

```bash
WECOM_BOT_ID=aibxxxxxxxxxxxxxxxx
WECOM_BOT_SECRET=your_bot_secret
```

### 4. Start Service

```bash
pm2 start ecosystem.config.cjs
pm2 logs zylos-wecom
```

### 5. Test

Send a message to your WeCom bot. The first private message sender becomes the owner.

## Configuration

### Config File

`~/zylos/components/wecom/config.json`

```json
{
  "enabled": true,
  "internal_port": 4459,
  "owner": { "bound": false, "user_id": "", "name": "" },
  "dmPolicy": "owner",
  "dmAllowFrom": [],
  "groupPolicy": "allowlist",
  "groups": {},
  "message": {
    "context_messages": 10,
    "locale": "zh-CN",
    "welcome_text": "",
    "welcome_texts": {
      "zh-CN": "你好，我是 Zylos。",
      "en-US": "Hello, I'm Zylos."
    }
  },
  "doc": { "fetch_timeout_ms": 5000, "persist_openclaw_compat": true },
  "ws": {
    "url": "wss://openws.work.weixin.qq.com",
    "heartbeat_interval": 30000,
    "reconnect_initial_delay": 1000,
    "reconnect_max_delay": 30000
  }
}
```

### Admin CLI

```bash
ADM="node ~/zylos/.claude/skills/wecom/src/admin.js"

$ADM show                    # Show full config
$ADM show-owner              # Show owner info
$ADM set-dm-policy owner     # Set DM policy
$ADM list-dm-allow           # List DM allowlist
$ADM add-dm-allow <user_id>  # Add user to allowlist
$ADM help                    # Show all commands
```

## Document MCP Bootstrap

After WebSocket authentication succeeds, `zylos-wecom` best-effort requests the WeCom doc MCP config via `aibot_get_mcp_config` with `biz_type: "doc"`.

Persisted paths:

- Primary: `~/zylos/components/wecom/wecom-mcp-config.json`
- Compatibility mirror: `~/.openclaw/wecomConfig/config.json`

This only bootstraps config. Later document operations should be handled by a separate `wecom-doc` skill/flow through `mcporter`.

The helper guide script supports localized output:

```bash
node scripts/print-wecom-doc-auth-guide.js --locale en-US
```

Locale priority is `--locale` -> `config.message.locale` -> `LANG/LC_*` -> `zh-CN`.

The same locale resolution is now used by the admin CLI and helper scripts such as:

```bash
node src/admin.js help --locale en-US
node scripts/setup-wecom-doc-mcp.js --locale en-US
node scripts/send.js --locale en-US "<endpoint_id>" "message"
```

Runtime status logs and welcome-message selection follow the same locale chain.
For welcome messages, `message.welcome_texts[locale]` is preferred and `message.welcome_text` is kept as a legacy fallback.

For manual local bootstrap into `mcporter`, this repo now includes:

```bash
node scripts/setup-wecom-doc-mcp.js
```

## Access Control

### DM Policy

| Policy | Behavior |
|--------|----------|
| `owner` | Only the owner can DM (default, most restrictive) |
| `allowlist` | Only users in dmAllowFrom can DM |
| `open` | Anyone can DM |

Owner always bypasses all access checks.

### Group Policy

| Policy | Behavior |
|--------|----------|
| `disabled` | All group messages are dropped |
| `allowlist` | Only configured groups are active (default) |
| `open` | Respond to all groups |

## Architecture

See [DESIGN.md](./DESIGN.md) for detailed architecture documentation.

## Service Management

```bash
pm2 status zylos-wecom     # Check status
pm2 logs zylos-wecom       # View logs
pm2 restart zylos-wecom    # Restart service
pm2 stop zylos-wecom       # Stop service
```

## License

[MIT](./LICENSE)
