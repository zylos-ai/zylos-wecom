---
name: wecom
version: 0.1.0
description: >-
  WeCom (企业微信) communication channel. Receives webhook events and sends messages
  via WeCom REST API. Use when: (1) replying to WeCom messages (DM or group),
  (2) sending proactive messages or media (images, files) to WeCom users,
  (3) managing DM access control (dmPolicy: open/allowlist/owner, dmAllowFrom list),
  (4) managing group access control (groupPolicy, per-group allowFrom),
  (5) configuring the bot (admin CLI, markdown settings, agent ID),
  (6) troubleshooting WeCom webhook or message delivery issues.
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
    - name: WECOM_CORP_ID
      description: "Corp ID (企业ID, from WeCom admin console)"
    - name: WECOM_CORP_SECRET
      description: "Corp Secret (应用Secret)"
      sensitive: true
    - name: WECOM_AGENT_ID
      description: "Agent ID (应用AgentId)"
    - name: WECOM_TOKEN
      description: "Webhook verification token (回调Token)"
      sensitive: true
    - name: WECOM_ENCODING_AES_KEY
      description: "Encoding AES Key (回调EncodingAESKey, 43 chars)"
      sensitive: true

next-steps: "BEFORE starting the service: 1) Ensure all WECOM_* env vars are set in ~/zylos/.env. 2) In WeCom admin console (work.weixin.qq.com), create a self-built app. 3) Set the app's callback URL to https://<your-domain>/wecom/webhook. 4) Copy Token and EncodingAESKey from the callback config to .env. 5) Enable 'receive messages' API. 6) Start the service (pm2 restart zylos-wecom). First DM to the bot will auto-bind the sender as owner."

http_routes:
  - path: /wecom/webhook
    type: reverse_proxy
    target: localhost:3459
    strip_prefix: /wecom

dependencies:
  - comm-bridge
---

# WeCom

WeCom (企业微信) communication channel for zylos.

Depends on: comm-bridge (C4 message routing).

## Sending Messages

```bash
# Via C4 bridge (standard path)
node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js "wecom" "<user_id>" "Hello!"

# Send image
node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js "wecom" "<user_id>" "[MEDIA:image]/path/to/image.png"

# Send file
node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js "wecom" "<user_id>" "[MEDIA:file]/path/to/file.pdf"
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

# Message Settings
$ADM set-markdown <on|off>                    # Toggle markdown message rendering
```

After changes, restart: `pm2 restart zylos-wecom`

## Config Location

- Config: `~/zylos/components/wecom/config.json`
- Logs: `~/zylos/components/wecom/logs/`
- Media: `~/zylos/components/wecom/media/`

## WeCom Setup

### 1. Credentials

Add to `~/zylos/.env`:

```bash
WECOM_CORP_ID=ww...
WECOM_CORP_SECRET=your_corp_secret
WECOM_AGENT_ID=1000002
WECOM_TOKEN=your_callback_token
WECOM_ENCODING_AES_KEY=your_43_char_encoding_aes_key
```

### 2. WeCom Admin Console

In the WeCom admin console (work.weixin.qq.com):

1. Create a self-built application (自建应用)
2. Note the AgentId and Secret
3. In "Receive Messages" (接收消息) settings:
   - Set callback URL: `https://<your-domain>/wecom/webhook`
   - Set Token and EncodingAESKey (copy to .env)
4. Enable message receiving API

### 3. Message Types

Supported incoming: text, image, voice, video, file
Supported outgoing: text, markdown, image, file

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
