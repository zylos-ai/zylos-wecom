# WeCom Dashboard Scan Onboarding Design

Date: 2026-04-02
Branch: `feat/wecom-scan-onboarding`

## Goal

Add a dashboard-friendly WeCom onboarding flow that reuses the verified QR bootstrap:

1. Request WeCom QR authorization
2. Show QR in dashboard
3. Poll for completion
4. Persist `WECOM_BOT_ID` and `WECOM_BOT_SECRET` into the existing `~/zylos/.env`
5. Keep the current runtime and manual credential path unchanged

This is intentionally an onboarding layer only. The existing WebSocket bot runtime stays as-is.

## Current CLI Baseline

Current branch already has a CLI-first implementation:

- `src/lib/scan-onboard.js`
  - calls `https://work.weixin.qq.com/ai/qc/generate?source=wecom-cli&plat=...`
  - polls `https://work.weixin.qq.com/ai/qc/query_result?scode=...`
  - returns `botId` and `secret` on success
- `src/admin.js`
  - exposes `scan-onboard`
- `src/lib/config.js`
  - writes the returned credentials back to the existing `~/zylos/.env`

So the dashboard design should reuse the same backend QR flow, not invent a second protocol.

## WhatsApp Reference Pattern

The closest existing dashboard pattern is WhatsApp:

1. Component runtime generates QR
2. Runtime writes `qr.png` + `status.json` into component data dir
3. Provision service SSHes into the VM and reads those files
4. Provision service returns QR as base64 PNG
5. API route proxies the result to dashboard
6. Frontend polls every few seconds until `connected` or `error`

Relevant reference points:

- `zylos-whatsapp/src/index.js`
  - QR is written to `~/zylos/components/whatsapp/qr.png`
- `coco-dashboard/infra/coco-provisioning/src/provision-service.js`
  - `/whatsapp-qr`
  - reads status + `qr.png`
- `coco-dashboard/apps/api/src/services/channel-provision/channel-provision.ts`
  - `requestWhatsAppQr()`
- `coco-dashboard/apps/api/src/routes/channels.ts`
  - `POST /api/v1/channels/:employeeId/whatsapp/qr`
- `coco-dashboard/apps/web/src/app/dashboard/employees/[id]/page.tsx`
  - starts polling and renders QR image

## Key Difference Vs WhatsApp

WhatsApp QR is produced by the long-running component runtime and exposed as a file.

WeCom QR is different:

- the QR comes from a short-lived HTTP bootstrap call to WeCom
- we get `scode` + `auth_url` immediately
- success is determined by polling `query_result`
- on success we receive `botid` + `secret`

So for WeCom there is no need to store a QR PNG file on disk first.

The dashboard-friendly shape should be:

1. backend starts a scan session
2. backend returns `scode`, `authUrl`, and either a rendered QR image or enough data for frontend rendering
3. frontend polls backend by `scode`
4. backend polls WeCom or proxies poll status
5. backend writes credentials into `.env` once success arrives

## Recommended Architecture

Use a session-based API, not a single long-polling endpoint.

### Why

WhatsApp can get away with a single polling endpoint because the VM persists QR state in files.

WeCom scan flow is more naturally modeled as:

- `start`
- `poll`
- `complete`

This avoids:

- long synchronous requests waiting for up to 5 minutes
- duplicated QR generation on every refresh
- frontend ambiguity over whether it should reuse or replace an existing QR

## Proposed API Shape

### 1. Start Scan

`POST /api/v1/channels/:employeeId/wecom/scan`

Purpose:

- verify employee ownership and Zylos agent type
- request a fresh QR from the instance-side WeCom helper
- create or replace one active scan session
- return dashboard render data

Response:

```json
{
  "success": true,
  "data": {
    "status": "qr_ready",
    "sessionId": "wcs_...",
    "scode": "....",
    "authUrl": "https://work.weixin.qq.com/...",
    "qrImage": "data:image/png;base64,...",
    "expiresInSec": 300
  }
}
```

Notes:

- `sessionId` is dashboard-facing state
- `scode` may be returned for diagnostics, but frontend should key off `sessionId`
- `qrImage` can be either:
  - full `data:image/png;base64,...`
  - or raw base64 with frontend prefixing
- `expiresInSec` should default to 300 to match current CLI timeout

### 2. Poll Scan Status

`GET /api/v1/channels/:employeeId/wecom/scan/:sessionId`

Purpose:

- check whether QR is still pending
- surface `success`, `expired`, or `error`
- on success, persist credentials and mark the channel connected

Response states:

```json
{ "success": true, "data": { "status": "qr_ready", "expiresInSec": 241 } }
{ "success": true, "data": { "status": "authorizing" } }
{ "success": true, "data": { "status": "connected", "botId": "..." } }
{ "success": true, "data": { "status": "expired" } }
{ "success": true, "data": { "status": "error", "error": "..." } }
```

Recommended semantics:

- `qr_ready`: waiting for user scan / approval
- `authorizing`: scan happened, waiting for final WeCom success result
- `connected`: credentials persisted successfully
- `expired`: session exceeded TTL, frontend should request a new QR
- `error`: terminal failure

### 3. Cancel Scan

Optional:

`DELETE /api/v1/channels/:employeeId/wecom/scan/:sessionId`

Purpose:

- release server-side session state early
- mainly cleanup, not required for correctness if sessions are short-lived

## Instance-Side Responsibilities

The existing branch already has the WeCom QR bootstrap logic. For dashboard support, add an instance-side helper with two responsibilities:

1. `startScanSession()`
2. `pollScanSession()`

Recommended storage:

- keep session state in `~/zylos/components/wecom/scan-session.json`
- only one active session at a time

Suggested file shape:

```json
{
  "sessionId": "wcs_123",
  "scode": "abc",
  "authUrl": "https://work.weixin.qq.com/...",
  "createdAt": "2026-04-02T12:34:56.000Z",
  "expiresAt": "2026-04-02T12:39:56.000Z",
  "status": "qr_ready"
}
```

Why keep state on disk:

- same operational model as other channel data
- survives brief process restarts
- easy for provision service or local admin commands to inspect

## Where To Persist Credentials

Do not introduce a second runtime credential source.

On success:

1. write `WECOM_BOT_ID`
2. write `WECOM_BOT_SECRET`
3. keep using the existing `.env` path
4. restart `zylos-wecom` if needed, or instruct caller to do so

This preserves the rule the user requested:

- manual credential entry still works
- scan onboarding simply fills the same destination
- runtime remains unchanged

## Dashboard Rendering Options

Two workable options:

### Option A: backend returns PNG/base64

Pros:

- exactly matches WhatsApp dashboard behavior
- frontend is trivial
- no extra QR library required in dashboard

Cons:

- backend must render QR image

### Option B: backend returns `authUrl`, frontend renders QR

Pros:

- less backend image work
- frontend can control sizing and styling

Cons:

- dashboard needs a QR rendering dependency or reuse of an existing one

Recommendation:

Use Option A for consistency with WhatsApp unless the dashboard already prefers client-side QR rendering.

## Polling Strategy

Use the WhatsApp flow as the UX reference, but tighten timeout handling.

Recommended frontend behavior:

- poll every 3 to 5 seconds
- keep a hard stop at 5 minutes
- show a visible countdown
- when countdown hits zero:
  - stop polling
  - show `expired`
  - offer a `Refresh QR` action

Recommended backend behavior:

- reject polling once `Date.now() > expiresAt`
- return `expired` without making further WeCom poll requests

## Suggested Status Mapping

Map WeCom results to dashboard states:

- before scan: `qr_ready`
- scan observed but not final success: `authorizing`
- got `botid + secret`: `connected`
- exceeded TTL: `expired`
- WeCom terminal failure / parse failure / write failure: `error`

This is cleaner than reusing WhatsApp's exact `generating/connecting` wording.

## Provision Service Integration

Mirror the WhatsApp layering:

1. dashboard API route calls `channel-provision`
2. `channel-provision` calls provision service
3. provision service SSHes to the instance helper or runs a local Node snippet
4. instance helper talks to WeCom
5. result flows back up

Suggested provision service endpoints:

- `POST /wecom-scan/start`
- `POST /wecom-scan/poll`

Why separate endpoints instead of one:

- matches the real QR lifecycle
- avoids 5-minute request hangs
- easier rate limiting and lock handling

## API Route Layer In Dashboard

Suggested dashboard API routes:

- `POST /api/v1/channels/:employeeId/wecom/scan`
- `GET /api/v1/channels/:employeeId/wecom/scan/:sessionId`

When `connected` comes back:

- ensure the WeCom channel record exists
- set status to `connected`
- clear any `lastDeployError`

This should mirror the existing WhatsApp route behavior after successful pairing.

## Frontend UX

Recommended WeCom card states:

1. idle
2. generating QR
3. QR ready
4. authorizing
5. connected
6. expired
7. error

Recommended UI copy:

- QR ready: "Use WeCom to scan and authorize this bot"
- authorizing: "Scan detected, waiting for WeCom to finish issuing Bot ID and Secret"
- expired: "QR expired, request a new one"

## Security Notes

- never return `secret` to the browser
- browser does not need `botId` either, except maybe optional success display
- credentials should be written server-side only
- only authenticated owner/user for the instance can start or poll scan
- enforce one active scan session per instance
- add rate limit similar to WhatsApp QR endpoint

## Recommended Minimal Rollout

Phase 1:

- keep current CLI `scan-onboard`
- add instance-side session helper
- add provision service `start` + `poll`
- add dashboard API route + basic frontend QR display

Phase 2:

- add explicit session cancel
- add restart hook for `zylos-wecom` after successful credential write
- add better audit logging and retry UX

## Bottom Line

The WhatsApp pattern is useful mainly as a dashboard integration pattern:

- API route
- provision service
- frontend polling
- success state reconciliation

But the WeCom QR itself should not copy WhatsApp's file-based `qr.png` model literally.

For WeCom, the right design is:

- session-based QR bootstrap
- dashboard receives rendered QR or `authUrl`
- backend polls WeCom by `scode`
- backend writes credentials to existing `.env`
- runtime remains unchanged
