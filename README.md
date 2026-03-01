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

- **Webhook Integration** -- Receive WeCom messages via encrypted webhook callbacks
- **WeCom Encryption** -- Full AES-256-CBC encryption/decryption per WeCom specification
- **Message Types** -- Text, markdown, image, file sending and receiving
- **Media Handling** -- Upload and download media via WeCom temporary media API
- **Access Control** -- DM policy (open/allowlist/owner) and group policy with per-group configuration
- **Owner Auto-Binding** -- First private message sender becomes the owner
- **Context Tracking** -- In-memory chat history for contextual conversations
- **C4 Bridge** -- Standard Zylos communication bridge integration
- **Admin CLI** -- Configuration management without manual JSON editing
- **Hot Reload** -- Config changes take effect without restart (most settings)
- **Graceful Shutdown** -- Clean resource cleanup on SIGINT/SIGTERM

## Prerequisites

- Node.js >= 20.0.0
- A WeCom (企业微信) enterprise account
- A self-built application with message receiving enabled
- Public HTTPS URL for webhook callbacks

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

### 2. Configure Credentials

Add to `~/zylos/.env`:

```bash
WECOM_CORP_ID=ww...
WECOM_CORP_SECRET=your_corp_secret
WECOM_AGENT_ID=1000002
WECOM_TOKEN=your_callback_token
WECOM_ENCODING_AES_KEY=your_43_char_encoding_aes_key
```

### 3. WeCom Console Setup

1. Go to [WeCom Admin Console](https://work.weixin.qq.com)
2. Create a self-built application (自建应用)
3. In the app settings, enable "Receive Messages" (接收消息):
   - Set callback URL: `https://your-domain.com/wecom/webhook`
   - Set Token and EncodingAESKey (same as in .env)
4. Note the AgentId and Secret

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
  "webhook_port": 3459,
  "bot": { "agent_id": 0 },
  "owner": { "bound": false, "user_id": "", "name": "" },
  "dmPolicy": "owner",
  "dmAllowFrom": [],
  "groupPolicy": "allowlist",
  "groups": {},
  "proxy": { "enabled": false, "host": "", "port": 0 },
  "message": { "context_messages": 10, "useMarkdownCard": false }
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
$ADM set-markdown on         # Enable markdown messages
$ADM help                    # Show all commands
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
