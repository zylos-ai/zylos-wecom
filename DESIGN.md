# WeCom Component Design

## Architecture Overview

zylos-wecom is a communication component that bridges WeCom (企业微信) with the Zylos agent ecosystem via the C4 Communication Bridge.

Uses the **Intelligent Robot WebSocket long connection** mode (智能机器人长连接), connecting to WeCom's WebSocket server. No public IP, SSL, or callback URL required.

```
WeCom Servers
     |
     | wss://openws.work.weixin.qq.com
     v
[WebSocket Client]
     |
     | authenticate (aibot_subscribe)
     | heartbeat (ping, 30s)
     v
[Message Processing]
     |
     | execFile c4-receive.js
     v
[C4 Bridge] --> Claude
     |
     | execFile send.js
     |   -> POST /internal/send
     v
[Main Process WebSocket]
     |
     | aibot_respond_msg / aibot_send_msg
     v
WeCom Servers --> User
```

## Key Design Decisions

### WebSocket Long Connection (vs HTTP Callback)

Chose WebSocket mode because:
- No public IP or SSL certificate required
- No WeCom callback URL configuration needed
- Only 2 credentials needed (botId + secret) vs 5 in callback mode
- Lower latency (persistent connection vs HTTP round-trip)
- Native streaming response support (for future use)
- Simpler deployment

### Raw WebSocket (vs Official SDK)

Uses the `ws` library directly instead of `@wecom/aibot-node-sdk`:
- Full control over connection lifecycle
- Well-documented protocol (5 frame types)
- Avoids SDK version lock-in and API uncertainty
- Minimal dependency footprint

### Reply vs Proactive Send

Two sending modes:
- **Reply** (`aibot_respond_msg`): Uses the `req_id` from the original callback. Must be sent within 6 minutes. Preferred for responsiveness.
- **Proactive** (`aibot_send_msg`): Independent message, uses a chat ID. Used when reply window expires or for bot-initiated messages.

The system tracks pending request IDs with a 5-minute TTL and automatically falls back to proactive mode.

### Internal HTTP API

send.js (spawned by C4 in a separate process) communicates with the main process via an internal HTTP API on `127.0.0.1:4459`:
- `POST /internal/send` - Send message via WebSocket
- `POST /internal/record-outgoing` - Record bot messages to history

Authenticated with a random UUID token written to `.internal-token` file at startup.

### Document MCP Bootstrap

After WS authentication succeeds, the service performs a best-effort `aibot_get_mcp_config` request for `biz_type: "doc"`.

The result is persisted for later doc skill usage:

- Zylos-native path: `~/zylos/components/wecom/wecom-mcp-config.json`
- OpenClaw-compatible mirror: `~/.openclaw/wecomConfig/config.json`

This keeps document execution out of the always-on channel service while still allowing later `mcporter`-based document workflows.

### User Name Resolution

Without corp API access (no `corpSecret`), user names are:
1. Extracted from incoming message callbacks (if `from.name` is present)
2. Cached to `user-cache.json` with 24-hour TTL
3. Falling back to `userId` string

### Owner Auto-Binding

First private message sender becomes the owner:
- Owner always bypasses all permission checks
- Stored in config.json for persistence across restarts
- Can be manually changed via admin CLI

## Data Flow

### Incoming Message

1. WebSocket receives `aibot_msg_callback` JSON frame
2. Extract: msgId, chatType, from.userid, msgtype, content
3. Deduplicate by msgId (10-minute TTL)
4. Track reqId for reply (5-minute TTL)
5. Check permissions (DM policy / group policy)
6. Auto-bind owner if first DM
7. Cache sender name if available
8. Record to in-memory history
9. Format as C4 message and forward via c4-receive.js

### Outgoing Message

1. C4 bridge calls send.js with endpoint + message
2. Parse endpoint (userId, type, msgId)
3. Split into chunks if > 2000 chars
4. POST to internal API at 127.0.0.1:4459/internal/send
5. Main process looks up reqId → send reply frame, or fallback to proactive
6. Record outgoing to history

## File Layout

| Path | Purpose |
|------|---------|
| `src/index.js` | WebSocket client, message processing, internal API |
| `src/admin.js` | Configuration management CLI |
| `src/lib/config.js` | Config loader with hot-reload |
| `scripts/send.js` | C4 outbound interface |
| `hooks/` | Install/upgrade lifecycle hooks |

## Configuration

### Secrets (~/zylos/.env)

```
WECOM_BOT_ID       - Intelligent Robot Bot ID (aibXXX)
WECOM_BOT_SECRET   - Intelligent Robot Secret
```

### Runtime Config (~/zylos/components/wecom/config.json)

Non-sensitive runtime configuration:
- enabled: service on/off toggle
- internal_port: internal API port (default: 4459)
- owner: auto-bound owner info
- dmPolicy / dmAllowFrom: DM access control
- groupPolicy / groups: group access control
- message: context limits, markdown toggle
- ws: WebSocket URL, heartbeat interval, reconnect settings

## WebSocket Protocol

| Frame | Direction | Purpose |
|-------|-----------|---------|
| `aibot_subscribe` | → Server | Auth with botId + secret |
| `ping` | → Server | Heartbeat (30s interval) |
| `aibot_msg_callback` | ← Server | Incoming user message |
| `aibot_event_callback` | ← Server | Events (enter_chat, etc.) |
| `aibot_respond_msg` | → Server | Reply to message |
| `aibot_send_msg` | → Server | Proactive message |
