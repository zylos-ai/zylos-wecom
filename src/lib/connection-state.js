/**
 * Component-reported connection state (zylos-openmax#34).
 *
 * zylos-openmax's channel-connect verification reads
 * ~/zylos/components/wecom/runtime/connection-state.json to learn the bot's
 * REAL login state instead of trusting pm2 process health alone (a wecom
 * process with rejected credentials still shows pm2 `online`). Contract:
 *
 *   {
 *     "state": "connected" | "auth_failed" | "connecting" | "disconnected",
 *     "detail": "<short human reason, optional>",
 *     "updatedAt": "<ISO8601>"
 *   }
 *
 * The component writes the file on every connection-state transition using an
 * atomic write (tmp file + rename). openmax treats the file as authoritative
 * only while fresh (updatedAt <= 10 minutes old); stale or absent falls back
 * to the pm2-online check.
 *
 * Best-effort by design: writeConnectionState never throws (a state-report
 * failure must never break the bot) and the detail must NEVER contain
 * secrets (bot id/secret, tokens).
 */

import fs from 'fs';
import path from 'path';

export const CONNECTION_STATES = ['connected', 'auth_failed', 'connecting', 'disconnected'];

const DETAIL_MAX_CHARS = 200;

// Module-level memory of the last successfully written state, so callers can
// avoid clobbering an authoritative terminal state (auth_failed) with the
// generic `disconnected` that the ws close event fires right after it.
let lastState = null;

// Resolved lazily (not at import time) so tests can point HOME at a tmpdir.
export function resolveConnectionStatePath() {
  return path.join(process.env.HOME, 'zylos/components/wecom/runtime/connection-state.json');
}

export function lastWrittenState() {
  return lastState;
}

/**
 * Atomically write the connection-state file. Never throws — failures are
 * logged as warnings and swallowed.
 * @param {'connected'|'auth_failed'|'connecting'|'disconnected'} state
 * @param {string} [detail] short human reason; must never contain secrets
 */
export function writeConnectionState(state, detail = '') {
  try {
    const file = resolveConnectionStatePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const payload = { state, updatedAt: new Date().toISOString() };
    const d = String(detail || '').replace(/\s+/g, ' ').trim();
    if (d) payload.detail = d.slice(0, DETAIL_MAX_CHARS);
    const tmp = `${file}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
    fs.renameSync(tmp, file);
    lastState = state;
  } catch (err) {
    console.warn(`[wecom] failed to write connection-state.json: ${err.message}`);
  }
}

/**
 * Map an aibot_subscribe acknowledgement frame to a connection state.
 * errcode 0 (or body.code 0) means the bot credentials were accepted;
 * anything else is an authentication failure with `code <errcode>: <errmsg>`
 * as the human-readable detail (WeCom error strings carry no secrets).
 * @param {object} frame parsed WS frame
 * @returns {{ state: 'connected'|'auth_failed', detail: string }}
 */
export function subscribeAckToState(frame) {
  if (frame?.errcode === 0 || frame?.body?.code === 0) {
    return { state: 'connected', detail: '' };
  }
  const code = frame?.errcode ?? frame?.body?.code;
  const msg = frame?.errmsg ?? frame?.body?.msg ?? '';
  return {
    state: 'auth_failed',
    detail: `code ${code ?? 'unknown'}${msg ? `: ${msg}` : ''}`,
  };
}
