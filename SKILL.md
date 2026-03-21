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

# Message Settings
$ADM set-markdown <on|off>                    # Toggle markdown message rendering
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
