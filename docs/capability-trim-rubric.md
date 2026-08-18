# WeCom Capability Trim Rubric

## Scope

This document decides whether a zylos-wecom capability should be `TRIM`,
`KEEP`, or `DEFER` when an official `wecom-cli` or `wecom-unified` capability
appears to overlap it.

This round is analysis only. It does not delete, replace, disable, or reroute
any capability. Any later trim requires its own implementation scope, tests,
rollback boundary, and Review.

## Core review action

- **Core action:** Apply one rubric to a named component capability.
- **Success result:** The capability receives a reproducible decision with
  evidence, safety gates, and explicit prerequisites for any future trim.
- **V1 includes:** The rubric, current inventory, decisions, and adversarial
  examples in this document.
- **Not now:** Code deletion, vendor snapshot edits, production changes,
  automatic migration, or a generic architecture rewrite.
- **Review gate:** A reviewer can replay every decision against the current
  source and reject any recommendation that crosses a must-keep boundary.

## Decision labels

| Label | Meaning |
| --- | --- |
| `KEEP (must-keep)` | Removing or delegating the capability would break transport, identity, authorization, delivery, or an established security invariant. |
| `KEEP` | The capability has no equivalent official CLI outcome, or remains a necessary component responsibility without a hard security classification. |
| `TRIM` | The official CLI is the proven authority for the same user outcome and the local path adds no required transport, identity, security, or delivery semantics. This is a recommendation for a later implementation, not authorization to delete now. |
| `DEFER` | Overlap is plausible, but parity, consumer, migration, or rollback evidence is incomplete. Keep the current path until those gaps are closed. |

### Classification unit and precedence

Classify the smallest active behavior that can be migrated and reviewed. A
`TRIM` decision can remove a local behavior from active authority without
authorizing deletion of the file that documents or packages it. This matters
for the pinned upstream snapshots: root-component policy may supersede generic
install or authorization instructions, while P1-2 still requires every
vendored file to remain byte-for-byte present.

When a row contains separable behaviors, split it before deciding. If it cannot
be split safely, the most protective applicable label wins in this order:
`KEEP (must-keep)` > `KEEP` > `DEFER` > `TRIM`.

## Rubric

Evaluate the gates in order. Stop at the first decisive result.

### Gate 1: Must-keep safety boundary

Classify `KEEP (must-keep)` if any answer is yes:

1. Does the capability own WebSocket subscribe, heartbeat, reconnect, callback,
   reply-window, or proactive-send behavior?
2. Does it bridge channel traffic to or from C4, including local channel
   history and restart delivery semantics?
3. Does replacing it change the acting principal, such as Bot ID/Secret versus
   the account-authorized CLI identity?
4. Does it enforce owner/group access, P0-1 message-plane isolation, P0-2
   endpoint provenance, or P1-1 durable delivery?
5. Does it own the component-specific CLI install, pin, authorization, or
   integrity lifecycle that generic upstream guidance cannot safely perform?
6. Is the apparent overlap only at the payload level while the trust,
   destination, retry, or acknowledgement contract differs?

An official CLI command with a similar verb is not enough to pass this gate.

### Gate 2: Equivalent outcome

For a possible `TRIM`, all answers must be yes:

1. The local and official paths act as the same principal.
2. They target the same resource and produce the same observable result.
3. Official CLI coverage includes the required read, write, error, and safety
   behavior, not only a nearby happy path.
4. The official path preserves required user confirmation, output redaction,
   and current-session restrictions.

If any answer is no, classify `KEEP`. If evidence is incomplete, classify
`DEFER`.

### Gate 3: Consumer and migration evidence

For a possible `TRIM`, all answers must be yes:

1. Every runtime, script, hook, Skill, and documented consumer is known.
2. No active consumer still requires a local-only operation.
3. Existing state and authorization have a tested migration or can remain
   safely unused.
4. Rollback does not require credential copying or reconstruction.

Unknown consumers or unmeasured usage require `DEFER`.

### Gate 4: Reviewable trim slice

The future trim must name one end-to-end outcome, the exact files and routes to
remove or reroute, positive and negative tests, and a rollback boundary. If it
cannot be reviewed independently, classify `DEFER` and split it further.

## Verified capability inventory

The current component has two independent data planes:

- The WebSocket channel handles conversation ingress, C4 routing, replies, and
  normal proactive messages (`DESIGN.md`, "Communication Channel vs Office
  CLI").
- The official CLI handles account-authorized office operations: contacts,
  documents, sheets, smart sheets/pages, calendar, meetings, todos, disk,
  email, office messages, and office media.

Evidence anchors for replaying the inventory:

- `DESIGN.md`, "Communication Channel vs Office CLI" and "Reply vs Proactive
  Send": independent principals, route isolation, authorization ownership, and
  callback/proactive channel semantics.
- `DESIGN.md`, "Document MCP Bootstrap" and "Restart delivery boundary": the
  active MCP compatibility sidecar and the P1-1 at-least-once boundary.
- `SKILL.md`, "Official WeCom CLI" and "企业微信文档 MCP（兼容路径）": modular
  CLI authority for covered office operations and the compatibility-only MCP
  route.
- `src/lib/wecom-cli-bridge.js`: the P0-1 explicit-office-message guard.
- `src/lib/wecom-cli-auth.js`: P0-2 one-time endpoint provenance and managed
  owner-DM authorization.
- `src/lib/message-delivery-outbox.js` and `src/index.js`: durable pending /
  delivered records, restart replay, and C4 forwarding.
- `src/lib/scan-onboard.js`: Bot ID/Secret acquisition for the WebSocket plane,
  distinct from official CLI account authorization.
- `hooks/wecom-cli-shared.js`, `src/lib/wecom-vendor-integrity.js`, and
  `references/wecom-vendor-manifest.json`: pinned CLI lifecycle and P1-2
  snapshot-integrity ownership.

The following matrix applies the rubric to the current source.

| Capability | Apparent official overlap | Decision | Basis |
| --- | --- | --- | --- |
| WebSocket subscribe, heartbeat, reconnect, callbacks, and request correlation | CLI can perform office API calls, but it does not own the channel event loop | `KEEP (must-keep)` | This is the component's transport. Removing it removes channel ingress and reply semantics. |
| C4 inbound forwarding and endpoint construction | None | `KEEP (must-keep)` | C4 is the component contract; the CLI is not a C4 transport. |
| C4 outbound `scripts/send.js` plus loopback `/internal/send` | `wecom-cli message aibot send` can send office messages | `KEEP (must-keep)` | Channel replies use callback `req_id`, a six-minute reply window, proactive fallback, and C4 logging. The CLI uses the authorized account and current-session destination rules. |
| Channel text chunking, skip handling, and outgoing history | CLI sends text/Markdown | `KEEP (must-keep)` | These are channel delivery and context semantics, not an office-message implementation. |
| Channel media receive/download and reply/proactive media send | `wecom-cli media` and `wecom-cli message` move office media | `KEEP (must-keep)` | Media IDs, acting principal, destination scope, and callback reply behavior differ. Sharing the word "media" does not make the paths interchangeable. |
| DM/group policy, owner binding, allowlists, and mention gating | CLI authorization identifies an account | `KEEP (must-keep)` | Channel admission policy is not supplied by CLI account authorization. |
| Local channel context, user-name cache, and idle-gated history replay | CLI can query some office/chat data | `KEEP (must-keep)` | Local context records what C4 saw and sent; it is part of agent continuity and delivery audit. It is not an office history mirror. |
| P1-1 stable-msgid outbox and restart recovery | No downstream exactly-once or CLI substitute | `KEEP (must-keep)` | It prevents silent loss across the WebSocket-to-C4 boundary and documents the acknowledgement gap. |
| P0-1 office-message intent guard in `wecom-cli-bridge.js` | It restricts the official CLI message domain itself | `KEEP (must-keep)` | Removing it can reroute ordinary channel traffic through the wrong principal and destination contract. |
| P0-2 one-time owner-DM endpoint provenance | Official `auth init` generates authorization material | `KEEP (must-keep)` | The CLI does not prove that the C4 reply endpoint was issued by the current owner DM or prevent group/cross-channel QR delivery. |
| Managed owner-DM CLI authorization helper | Generic upstream `wecom-cli auth init` guidance | `KEEP (must-keep)` | The helper supplies component-specific origin, owner, concurrency, cleanup, and safe-error controls while leaving encrypted CLI credentials under official ownership. |
| Pinned CLI install/upgrade lifecycle and P1-2 vendor integrity check | Vendored shared guidance contains generic install/auth steps | `KEEP (must-keep)` | Hooks and the manifest bind the supported binary and snapshots to component lifecycle. Generic blocking instructions are intentionally not authoritative here. |
| Bot credential scan onboarding | CLI account authorization also uses a QR | `KEEP (must-keep)` | Bot onboarding obtains `WECOM_BOT_ID` and `WECOM_BOT_SECRET` for WebSocket transport. CLI authorization obtains a separate account token. Removing it breaks the channel authentication lifecycle. |
| Admin CLI, config hot reload, and service policy management | None | `KEEP` | They configure the communication component, not office resources. |
| Official office domains | Some legacy MCP document operations overlap | `TRIM` | For an operation explicitly supported by the pinned CLI, the root Skill already makes the modular CLI authoritative and removes legacy MCP from the active route. Keep this policy trim. |
| Generic vendored install and blocking authorization instructions | Component hooks and managed owner-DM auth provide the supported lifecycle | `TRIM` | These instructions are already trimmed from active authority by the root Skill. Do not delete them from pinned snapshots; the override is explicit and P1-2 verifies snapshot purity. |
| Legacy document MCP bootstrap, config persistence, OpenClaw mirror, `mcporter` setup, and auth guide | CLI covers documents, document management, sheets, smart sheets, and smart pages | `DEFER` | The subsystem is now compatibility-only, but its dynamic MCP tool surface and active consumers have not been compared operation by operation against the pinned CLI. Deleting it now could remove a CLI-unsupported fallback. |
| Unified aggregate router and duplicated modular reference content | Modular Skills contain authoritative command guidance | `DEFER` | Unified still supplies ambiguous-intent routing and cross-domain workflows. Physical deduplication would mutate pinned snapshots and defeat P1-2 integrity; pursue consolidation upstream or at a future packaging boundary. |
| Duplicate `build_docx.py` copies inside pinned upstream layouts | Both snapshots carry equivalent helpers | `DEFER` | This is upstream packaging duplication, not two competing component capabilities. Local removal would make the vendored snapshot incomplete. |

## Safety counterexamples

These cases are the negative acceptance test for the rubric.

### "Both can send a message, so remove the channel sender"

Rejected by Gate 1. The channel sender replies with callback request state and
falls back to proactive Bot delivery. The CLI message domain uses an authorized
account and only destinations allowed by its current session. P0-1 exists
specifically to prevent this substitution.

### "Both use a QR, so keep only CLI authorization"

Rejected by Gate 1. Bot scan onboarding produces WebSocket Bot credentials;
CLI authorization produces account credentials in the official encrypted
store. Combining them changes both principal and transport.

### "Both handle files, so remove channel media"

Rejected by Gate 1. Channel media belongs to callback/proactive conversation
delivery. CLI media is an office-operation resource that produces or consumes
office `media_id` values. Their lifecycle and destination contracts differ.

### "CLI supports documents, so delete all MCP files now"

Rejected by Gate 3. CLI-first routing for covered operations is correct, but
the compatibility MCP exposes a dynamic tool list and its unmatched operations
and consumers have not been proven empty. The correct current decision is
`DEFER`, not speculative deletion.

### "Unified duplicates modular files, so delete the duplicates"

Rejected by Gates 2 and 3. Unified has a separate cross-domain routing role,
and both trees are pinned upstream snapshots. Local deletion would break the
integrity boundary without proving that routing value is unused.

## Recommended next increment

Choose only one follow-up: an operation-level parity and consumer audit of the
legacy document MCP compatibility subsystem.

That audit should:

1. Enumerate the live `wecom-doc` MCP tool catalog without invoking writes.
2. Map each tool to a pinned official CLI command or record the missing parity.
3. Identify every runtime, script, config file, Skill section, and external
   consumer of MCP state.
4. Record observed usage without exposing document content or credentials.
5. Propose one small deletion/reroute slice only if every affected operation has
   parity and every consumer has a migration and rollback path.

Until that evidence exists, retain the MCP compatibility subsystem and keep
official CLI first for operations it already supports.

## Future trim acceptance checklist

A later implementation may use `TRIM` only when its Review packet contains:

- the exact official CLI replacement command and pinned version;
- same-principal and same-result evidence;
- a complete consumer list;
- positive parity tests and negative safety tests;
- explicit proof that P0-1, P0-2, and P1-1 invariants remain intact;
- rollback instructions that do not copy or expose credentials;
- confirmation that no vendored snapshot was edited to manufacture parity;
- a separate authorization for the actual code or file removal.
