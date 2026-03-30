# WeCom Doc MCP Integration Plan

## Goal

Add a document capability to `zylos-wecom` that behaves like the `openclaw-china` split:

- the WeCom channel auto-fetches and persists the WeCom doc MCP config after WS auth
- a separate doc-facing skill/flow reuses that persisted config
- doc operations go through `mcporter`, not through direct Wedoc API calls

User-facing trigger scope:

- "企业微信文档"
- "智能表格"
- "创建文档"
- "编辑文档"
- "写文档"

## Current State in `zylos-wecom`

`zylos-wecom` today is a pure communication component:

- WS bot auth via `WECOM_BOT_ID` + `WECOM_BOT_SECRET`
- inbound messages forwarded to C4
- outbound messages sent back through internal HTTP API
- runtime config stored in `~/zylos/components/wecom/config.json`

What is missing for doc capability:

- no MCP config fetch during WS auth
- no persisted doc MCP config file
- no `mcporter` integration
- no doc-oriented skill/prompt entrypoint
- no session-level storage for created `docid`

## Reference Mapping from `openclaw-china`

The referenced project splits the feature into two parts:

### 1. Channel-side MCP bootstrap

In `extensions/wecom/src/mcp-config.ts`:

- sends `aibot_get_mcp_config` with `biz_type: "doc"`
- parses `url`, `type`, `is_authed`
- persists it to `~/.openclaw/wecomConfig/config.json`

In `extensions/wecom/src/ws-gateway.ts`:

- calls that fetch/persist flow right after WS authentication succeeds

### 2. Skill-side document execution

In the repo skill guide:

- checks `mcporter`
- checks whether `wecom-doc` is already configured
- falls back to persisted MCP config
- runs doc tools via `mcporter call wecom-doc.<tool>`
- keeps `docid` in session context
- limits editing to robot-created docs unless later expanded

That split is the right model for `zylos-wecom` too.

## Recommended Architecture for `zylos-wecom`

### A. Keep channel and doc execution separate

Do not turn `zylos-wecom` itself into a document editor.

Recommended split:

- `zylos-wecom` remains the communication/runtime component
- it only fetches, validates, and persists doc MCP config
- a separate doc skill handles `mcporter` usage

This keeps the channel service small and avoids embedding doc tool logic inside the always-on PM2 process.

### B. Reuse Zylos-native state paths

Do not reuse OpenClaw's exact storage path as the primary source of truth.

Recommended Zylos paths:

- channel-persisted MCP config: `~/zylos/components/wecom/wecom-mcp-config.json`
- optional compatibility mirror: `~/.openclaw/wecomConfig/config.json`

Why:

- Zylos runtime data already belongs under `~/zylos/components/wecom/`
- the compatibility mirror can help if `mcporter` or other tooling expects the OpenClaw location
- Zylos should not make `~/.openclaw` its only internal dependency

### C. Skill consumes persisted config, not live WS client

The doc skill should not talk to the running WS process directly.

Instead:

1. channel fetches doc MCP config during auth
2. channel writes it to disk
3. skill reads it when needed
4. skill configures or validates `mcporter`
5. skill executes doc operations through `mcporter`

That gives process isolation and a clean failure mode when doc auth has not been granted yet.

## Proposed Implementation

### Phase 1. Channel-side MCP config persistence

Add a new helper module, for example:

- `src/lib/mcp-config.js`

Responsibilities:

- issue `aibot_get_mcp_config` after successful WS auth
- request `biz_type: "doc"`
- apply timeout and structured error handling
- persist response to `~/zylos/components/wecom/wecom-mcp-config.json`
- optionally mirror to `~/.openclaw/wecomConfig/config.json`

Suggested stored format:

```json
{
  "updatedAt": "2026-03-28T06:00:00.000Z",
  "mcpConfig": {
    "doc": {
      "type": "streamable-http",
      "url": "https://...",
      "isAuthed": true
    }
  },
  "accounts": {
    "default": {
      "fetchedAt": "2026-03-28T06:00:00.000Z",
      "isAuthed": true,
      "mcpConfig": {
        "doc": {
          "type": "streamable-http",
          "url": "https://..."
        }
      }
    }
  }
}
```

Hook point:

- call this once on successful `aibot_subscribe` / auth completion in `src/index.js`

Non-goals for phase 1:

- no `mcporter`
- no doc creation
- no C4 command changes

### Phase 2. Doc skill for Zylos

Add a separate skill under the skill runtime, not inside the PM2 service logic.

Recommended location in this repo:

- `SKILL.md`

Responsibilities:

- trigger on doc/smart-sheet creation and editing intents
- check whether `mcporter` is installed
- check whether `wecom-doc` MCP server is already configured
- if not, read persisted MCP config from Zylos path first
- if needed, mirror/add config into `mcporter`
- list tools dynamically via `mcporter list wecom-doc --output json`
- call tools via `mcporter call ... --output json`

Recommended config lookup order:

1. `mcporter list wecom-doc --output json`
2. `~/zylos/components/wecom/wecom-mcp-config.json`
3. `~/.openclaw/wecomConfig/config.json` as compatibility fallback
4. ask user to authorize doc capability or provide MCP URL/config

### Phase 3. Session doc context handling

The skill needs a small amount of session memory:

- last created `docid`
- doc type
- title

This can live in conversation context rather than in the channel service.

Initial rule should match the reference behavior:

- editing is supported for docs created in the current session
- if the user asks to edit an arbitrary existing doc and there is no known `docid`, return a strict limitation message

That is the safest initial scope.

### Phase 4. Optional compatibility CLI

If repeated manual setup becomes common, add a small local helper script, for example:

- `scripts/setup-wecom-doc-mcp.js`

Purpose:

- read persisted MCP config from Zylos path
- register/update `mcporter` server config for `wecom-doc`
- print clear next-step guidance

This is optional. The skill can do the same checks inline at first.

## Concrete Changes by Area

### `src/index.js`

Add:

- import for MCP config helper
- call after successful WS auth
- logs that clearly distinguish:
  - fetch succeeded
  - no doc auth yet
  - fetch failed but channel remains healthy

Important:

- doc MCP failure must not break message delivery
- this must be best-effort sidecar behavior

### `src/lib/config.js`

Probably no required config schema change for the first version.

Optional additions:

- a doc section for local settings such as:
  - `doc.persist_openclaw_compat`
  - `doc.mcp_fetch_timeout_ms`

If omitted, hardcoded defaults are acceptable for v1.

### New helper module

Recommended API shape:

```js
export async function fetchWecomDocMcpConfig(ws, options = {}) {}
export async function saveWecomDocMcpConfig(accountId, config) {}
export function resolveWecomDocMcpConfigPath() {}
```

Keep it independent from the rest of the transport logic.

### New skill

Recommended contents:

- install/verify `mcporter`
- reuse persisted config
- dynamic tool discovery
- workflow examples:
  - create doc
  - create smart sheet
  - edit current doc
- error handling for:
  - no `mcporter`
  - daemon not running
  - MCP config missing
  - doc auth not granted

## Delivery Sequence

### Milestone 1

Channel persists doc MCP config after auth.

Acceptance:

- service starts normally
- auth still works
- file appears under `~/zylos/components/wecom/wecom-mcp-config.json`
- no regression in messaging

### Milestone 2

Skill can bootstrap `mcporter` from persisted config.

Acceptance:

- `mcporter list wecom-doc --output json` works after bootstrap
- missing-config path gives clear instructions

### Milestone 3

Skill can create doc and smart sheet.

Acceptance:

- can create normal doc
- can create smart sheet
- returns `docid` and link

### Milestone 4

Skill can edit session-created docs.

Acceptance:

- content append/update works for robot-created docs
- unsupported existing-doc edit path returns clear limitation

## Risks

### 1. Authorization ambiguity

`aibot_get_mcp_config` may return a URL but still require user-side authorization before useful calls succeed.

Mitigation:

- persist `isAuthed` when available
- surface a clear authorization-required message in the skill flow

### 2. Tool surface instability

The MCP tool list may change.

Mitigation:

- never hardcode tool names beyond bootstrap assumptions
- always inspect `mcporter list wecom-doc --output json` before calling tools

### 3. Cross-runtime path coupling

If only the OpenClaw path is used, Zylos becomes coupled to a foreign state directory.

Mitigation:

- store Zylos-native config first
- treat the OpenClaw path as a compatibility mirror only

### 4. Scope creep into direct Wedoc API integration

Direct Wedoc API calls would expand complexity and credential requirements.

Mitigation:

- keep the rule from the reference design: doc operations go through MCP, not direct Wedoc API

## Recommended First PR Scope

Keep the first PR narrow:

1. add MCP config fetch/persist helper
2. call it after WS auth
3. add the doc-MCP section into `SKILL.md`
4. document paths and behavior in README / DESIGN

Do not include in the first PR:

- arbitrary existing-doc editing support
- direct Wedoc API fallback
- richer persistent doc session database

## Suggested Branch Outcome

For this branch, the most useful deliverable is:

- a design doc
- no runtime behavior change yet

Then implement in two PRs:

1. channel-side MCP persistence
2. skill-side `mcporter` integration
