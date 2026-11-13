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

### Communication Channel vs Office CLI

The component has two independent WeCom data planes:

- The long-running WebSocket service handles incoming conversations, C4
  routing, replies, and normal proactive channel messages.
- The official `wecom-cli` handles account-authorized office operations such
  as contacts, documents, sheets, calendars, meetings, todos, disk, email,
  office messages, and media.

The office-message overlap is fail-closed. Code callers using
`src/lib/wecom-cli-bridge.js` may enter the CLI `message` domain only with the
`explicit-office-message` intent. Missing or different intent throws and logs
`WECOM_CLI_ROUTE_VIOLATION`; channel replies and normal proactive C4 messages
remain on `scripts/send.js` and never receive that intent.

The component lifecycle hooks install a pinned minimum CLI version. The CLI's
own encrypted authorization store remains separate from the channel's Bot ID
and Secret; the component never copies or reimplements CLI credentials.
Vendored upstream Skills remain unmodified snapshots. Their generic direct
install and blocking authorization bootstrap text is superseded by the root
component Skill: lifecycle hooks own installation and the managed owner-DM
helper owns authorization.

CLI authorization is a WeCom-native same-Bot owner-DM flow. The Agent first
runs `scripts/wecom-cli-auth.js --check-channel-bot`. When reauthorization is
required it starts the helper with `--reuse-channel-bot` as a managed process.
The helper validates
the structured endpoint against the bound owner and atomically consumes a
short-lived, one-time provenance record created when the WebSocket server
forwarded that exact owner-DM reply endpoint to C4. Group, non-owner,
reconstructed, changed, expired, and replayed endpoints fail closed with an
observable `WECOM_ENDPOINT_PROVENANCE_VIOLATION` before any send or CLI exec.
The helper supplies the configured channel Bot credentials to the official CLI
only through stdin/PTY, strips both credential variables from child
environments, and requires the resulting CLI Principal to exactly match the
channel Bot. No QR is generated and no additional Bot is created. A process
lock prevents overlapping authorization sessions and private temporary files
are removed when the helper finishes. The original operation is retried once
only after the exact-Bot check passes. Raw `wecom-cli auth init` and an
independent office Bot are not supported by this architecture because the
mandatory business-command gate rejects any non-channel Principal. Office
operations default to the configured owner only; broader access requires a
separately enforced policy.

The source package includes both upstream Skill layouts. The 14 modular CLI
skills are authoritative for execution details. The Unified snapshot is used
for aggregate intent routing and cross-domain workflows; overlapping command
guidance always resolves to the modular CLI skill.

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
3. Suppress known msgIds in any state (10-minute TTL)
4. Track reqId for reply (5-minute TTL)
5. Check permissions (DM policy / group policy)
6. Auto-bind owner if first DM
7. Cache sender name if available
8. Replay existing history and format the C4 message
9. Persist a `pending` delivery record keyed by the stable WeCom `body.msgid`
10. Forward to C4
11. Core has it: append channel history, then persist `delivered`.
    Rejected or unknown: persist `failed` and notify the user (except when Core
    already stored it)

### Restart delivery boundary

The delivery journal separates receipt from the C4 outcome. Each `msgid` is
forwarded at most once, following Core's c4-receive contract ("do not
automatically retry an uncertain or already committed inbound call"):

- C4 has no inbound idempotency key; a second forward stores a second row.
- c4-receive may store the message and keep running (route lookup up to 30s
  before the insert, status notice up to 30s after it), so it runs without a
  component timeout, and a failure without a structured result is an unknown
  outcome, not permission to resend.
- Outcomes: success or `persisted` non-empty -> `delivered`; `persisted: []`
  -> `failed`, user told to try again later; `persisted: null`, no structured
  result, or a crash -> `failed`, user told the message may not have arrived.
- A record still `pending` at startup was interrupted with an unknown outcome;
  it becomes `failed` and is not forwarded again.
- A lost `delivered` marker or history write after C4 accepted is logged only.

Known msgids in any state are suppressed during the 10-minute window that
covers WeCom's callback retries.

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
| `src/lib/wecom-cli-bridge.js` | Shell-free official CLI invocation and typed auth errors |
| `src/lib/wecom-cli-auth.js` | Owner-DM CLI authorization orchestration and C4 delivery |
| `scripts/send.js` | C4 outbound interface |
| `scripts/wecom-cli-auth.js` | Agent-facing managed CLI authorization entry point |
| `hooks/` | Install/upgrade lifecycle hooks, including pinned CLI setup |
| `references/wecom-cli/` | Authoritative 14-domain official CLI Skill snapshot |
| `references/wecom-unified/` | Aggregate official Unified Skill snapshot |

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
