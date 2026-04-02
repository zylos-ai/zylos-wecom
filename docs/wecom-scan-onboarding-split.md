# WeCom Scan Onboarding vs Hosted Account Transport

## Current Reality

`zylos-wecom` today is a WebSocket bot transport.

- auth is strictly `WECOM_BOT_ID` + `WECOM_BOT_SECRET`
- subscribe frame is built in `src/index.js` via `aibot_subscribe`
- credentials are read only from `~/zylos/.env` in `src/lib/config.js`
- owner binding happens later, on the first DM, and is unrelated to transport auth

This means the current runtime does not host or proxy a real WeCom user account.
It only runs an Intelligent Robot that already exists in WeCom.

## What "Scan Onboarding" Can Mean Here

There are two different product shapes:

### 1. Bot QR onboarding

Goal: reduce manual copy-paste of Bot ID + Secret.

Shape:

- user/admin scans a WeCom-provided authorization page or QR flow
- backend receives or derives bot-scoped metadata
- final persisted runtime state is still `WECOM_BOT_ID` + `WECOM_BOT_SECRET`
- the existing WebSocket transport remains unchanged after credentials are saved

This is a thin onboarding layer on top of the current transport, not a new channel architecture.

### 2. Hosted account transport

Goal: operate through a real employee/service account, similar to account takeover/hosting products.

Shape:

- auth artifact is no longer Bot ID + Secret
- transport would need account/session lifecycle management
- message ingress/egress model would differ from `aibot_subscribe` bot frames
- permission, identity, and group visibility semantics would change

This is a separate transport line and should not be framed as an extension of the current bot mode.

## Reuse Points for Bot QR Onboarding

The existing codebase already has one useful pattern: fetch remote config after WS auth, then persist it locally.

Relevant pieces:

- `src/index.js`: `refreshDocMcpConfig()` runs as best-effort sidecar work
- `src/lib/mcp-config.js`: parses server response and atomically saves local config

That pattern can be reused for bot onboarding:

- add a dedicated onboarding flow that requests bot-scoped info from WeCom
- validate the returned bot identifier and any secret/token material
- persist the result into a local credential store
- restart or reconnect the existing WS service using the saved bot credentials

The important boundary is that onboarding may change how credentials are obtained, but not how the runtime speaks after auth.

## Recommended Implementation Split

### Phase A. Add bot onboarding as a pre-transport credential bootstrap

Keep this outside the always-on message loop as much as possible.

- expose a small local admin command or HTTP endpoint for "start bot onboarding"
- persist temporary onboarding state separately from runtime config
- once bot credentials are acquired, write them into the runtime credential source
- reconnect `zylos-wecom` with the new credentials

Possible storage options:

- preferred: dedicated file under `~/zylos/components/wecom/`
- acceptable: staged output that an admin helper writes into `~/zylos/.env`

### Phase B. Keep transport code unchanged except for credential source indirection

Minimal runtime change:

- let `getCredentials()` read from a small resolved credential source abstraction
- default source remains `.env`
- future bot onboarding can populate the same resolved shape

This keeps `buildSubscribe()` and the rest of the WS protocol untouched.

### Phase C. Treat hosted-account mode as a new transport package or major branch

Do not mix it into the bot runtime behind flags.

Reasons:

- different auth artifact
- different operational risk
- likely different message/event protocol
- different failure and re-login model

If this path is pursued, it should start with a separate transport design doc, not with incremental edits to `aibot_subscribe` bot mode.

## Practical Conclusion

Near term, the implementable path is:

1. build "scan to obtain bot credentials"
2. save Bot ID + Secret
3. reuse the existing WebSocket bot runtime

Not the implementable path:

1. scan a WeCom account
2. keep that account online inside the current `zylos-wecom` bot transport

Those are different products.
