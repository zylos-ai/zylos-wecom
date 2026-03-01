# WeCom Component Design

## Architecture Overview

zylos-wecom is a communication component that bridges WeCom (企业微信) with the Zylos agent ecosystem via the C4 Communication Bridge.

```
WeCom Servers
     |
     | (HTTPS callback)
     v
[Express Webhook Server]  <-- port 3459
     |
     | decrypt (AES-256-CBC)
     | parse XML
     v
[Message Processing]
     |
     | execFile c4-receive.js
     v
[C4 Bridge] --> Claude
     |
     | execFile send.js
     v
[WeCom REST API]
     |
     | POST /cgi-bin/message/send
     v
WeCom Servers --> User
```

## Key Design Decisions

### No SDK Dependency

WeCom's API is straightforward REST/XML. Using direct HTTP calls via axios avoids:
- SDK version lock-in
- Unnecessary abstraction layers
- Large dependency trees

### XML Parsing Without Heavy Dependencies

WeCom webhooks send XML payloads. Rather than adding xml2js (~200KB), we use simple regex-based XML parsing. This is safe because:
- WeCom XML follows a strict, predictable schema
- We only extract known fields (no arbitrary traversal)
- CDATA sections are handled for text content

### Token Management

Access tokens are cached in-memory with expiry tracking:
- 7200 second lifetime from WeCom
- Refresh 5 minutes before actual expiry
- Automatic retry on invalid token errors (42001/40014)
- No persistent storage needed (tokens are cheap to obtain)

### Message Encryption

WeCom uses a specific encryption scheme:
1. EncodingAESKey (43 base64 chars) -> 32-byte AES key
2. IV = first 16 bytes of the key
3. AES-256-CBC encryption
4. Plaintext format: 16 random + 4-byte length + message + corp_id
5. Signature: SHA1(sort([token, timestamp, nonce, encrypted]))

This is implemented in `src/lib/crypto.js` using Node.js built-in `crypto` module.

### Owner Auto-Binding

First private message sender becomes the owner:
- Owner always bypasses all permission checks
- Stored in config.json for persistence across restarts
- Can be manually changed via admin CLI

### Internal API Security

The internal API (for send.js -> index.js communication) uses:
- Random UUID token generated at startup
- Written to `.internal-token` file (mode 0o600)
- Bound to 127.0.0.1 only
- Required in X-Internal-Token header

## Data Flow

### Incoming Message

1. WeCom POST to /webhook with encrypted XML
2. Verify msg_signature
3. Decrypt with EncodingAESKey
4. Parse XML to extract: MsgType, FromUserName, Content, etc.
5. Check permissions (DM policy / group policy)
6. Auto-bind owner if first DM
7. Resolve sender name (cached with TTL)
8. Record to in-memory history
9. Format as C4 message and forward via c4-receive.js

### Outgoing Message

1. C4 bridge calls send.js with endpoint + message
2. Parse endpoint (userId, type, msgId)
3. Check for media prefix ([MEDIA:image] or [MEDIA:file])
4. For text: split into chunks, send as text or markdown
5. For media: upload to WeCom, then send media message
6. Record outgoing to history via internal API

## File Layout

| Path | Purpose |
|------|---------|
| `src/index.js` | Webhook server, message processing |
| `src/admin.js` | Configuration management CLI |
| `src/lib/config.js` | Config loader with hot-reload |
| `src/lib/client.js` | WeCom API client, token management |
| `src/lib/crypto.js` | AES encryption/decryption |
| `src/lib/message.js` | Send/receive messages, media ops |
| `src/lib/contact.js` | User info lookup |
| `scripts/send.js` | C4 outbound interface |
| `hooks/` | Install/upgrade lifecycle hooks |

## Configuration

### Secrets (~/zylos/.env)

```
WECOM_CORP_ID      - Enterprise ID
WECOM_CORP_SECRET  - Application secret
WECOM_AGENT_ID     - Application agent ID
WECOM_TOKEN        - Webhook callback token
WECOM_ENCODING_AES_KEY - 43-char base64 encoding key
```

### Runtime Config (~/zylos/components/wecom/config.json)

Non-sensitive runtime configuration:
- enabled: service on/off toggle
- webhook_port: HTTP listener port
- owner: auto-bound owner info
- dmPolicy / dmAllowFrom: DM access control
- groupPolicy / groups: group access control
- proxy: HTTP proxy settings
- message: context limits, markdown toggle
