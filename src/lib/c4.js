import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { sessionGroupFromEndpoint } from './session-group.js';

export const GENERIC_REJECT_REPLY = '抱歉，这条消息暂时没能收下，请稍后再试。';
export const UNCERTAIN_REPLY = '抱歉，这条消息可能没有送达。如果几分钟内没有收到回复，请重新发送。';

/**
 * Whether the installed Core lists an optional c4-receive argument.
 * Reads `c4-receive-options.json` beside the c4-receive script on every call,
 * so a Core upgrade needs no restart. Missing or unreadable files, invalid
 * JSON and invalid shapes all mean unsupported.
 * @param {string} scriptPath - c4-receive.js path
 * @param {string} name - e.g. '--session-group'
 * @returns {boolean}
 */
export function c4ReceiveSupportsOption(scriptPath, name) {
  try {
    const manifest = JSON.parse(fs.readFileSync(
      path.join(path.dirname(scriptPath), 'c4-receive-options.json'), 'utf8'));
    return manifest !== null && typeof manifest === 'object' && !Array.isArray(manifest)
      && manifest.options !== null && typeof manifest.options === 'object'
      && !Array.isArray(manifest.options) && Object.hasOwn(manifest.options, name);
  } catch {
    return false;
  }
}

export function buildC4ReceiveArgs({ scriptPath, endpoint, content, sessionGroup }) {
  const args = [scriptPath, '--channel', 'wecom', '--endpoint', endpoint, '--json', '--content', content];
  if (sessionGroup != null && sessionGroup !== '' && c4ReceiveSupportsOption(scriptPath, '--session-group')) {
    args.push('--session-group', sessionGroup);
  }
  return args;
}

/**
 * Classify a structured c4-receive rejection by `error.persisted`.
 * - non-empty array: Core already stored the message; send nothing, do not resend.
 * - empty array: nothing was stored; ask the user to try again later.
 * - anything else (null, or absent): unknown.
 * @param {object} response - parsed `{ ok: false, error }` JSON
 * @returns {'committed'|'not_stored'|'uncertain'}
 */
export function classifyC4Rejection(response) {
  const persisted = response?.error?.persisted;
  if (!Array.isArray(persisted)) return 'uncertain';
  return persisted.length > 0 ? 'committed' : 'not_stored';
}

function parseC4Response(stdout) {
  if (!stdout) return null;
  try {
    return JSON.parse(String(stdout).trim());
  } catch {
    return null;
  }
}

/**
 * True when c4-receive never started (spawn itself failed), so Core cannot
 * have stored anything. Any other failure without a structured result has an
 * unknown outcome.
 */
function neverStarted(error) {
  return typeof error?.code === 'string'
    && typeof error.syscall === 'string' && error.syscall.startsWith('spawn');
}

function runReceive(args) {
  return new Promise((resolve) => {
    execFile('node', args, { encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({ error, stdout: stdout?.trim() || '', stderr: stderr?.trim() || '' });
    });
  });
}

/**
 * Send one inbound message to Core via c4-receive.
 *
 * The session group is derived only when the installed Core lists
 * --session-group, so older Cores get exactly the same arguments as before.
 * An endpoint that cannot be mapped is not sent: it never falls back to the
 * overall group. Core's error text only goes to the log.
 *
 * c4-receive runs without a timeout: Core may still be routing the message or
 * sending a status notice after storing it, and it has no inbound idempotency
 * key, so killing and resending would deliver the message twice. Following
 * Core's contract, a call that is stored or whose outcome is unknown is never
 * retried; only a call that never started is retried once.
 *
 * @returns {Promise<{ outcome: 'sent'|'committed'|'not_stored'|'uncertain', notice: string|null }>}
 *   `outcome` sent/committed means Core has the message. `notice` is the text
 *   to send the WeCom user, or null to send nothing.
 */
export async function sendToC4({ scriptPath, endpoint, content, logger = console, retryDelayMs = 2000 }) {
  let sessionGroup;
  if (c4ReceiveSupportsOption(scriptPath, '--session-group')) {
    try {
      sessionGroup = sessionGroupFromEndpoint(endpoint);
    } catch (error) {
      logger.error(`[wecom] No session group for ${endpoint}, not sent: ${error.message}`);
      return { outcome: 'not_stored', notice: GENERIC_REJECT_REPLY };
    }
  }

  for (let attempt = 1; ; attempt += 1) {
    const args = buildC4ReceiveArgs({ scriptPath, endpoint, content, sessionGroup });
    const { error, stdout, stderr } = await runReceive(args);
    const response = parseC4Response(stdout);

    if (response?.ok === false && response.error) {
      const kind = classifyC4Rejection(response);
      const { code, message } = response.error;
      if (kind === 'committed') {
        logger.warn(`[wecom] C4 rejected after commit (${code}), not resending: ${message}`);
        return { outcome: 'committed', notice: null };
      }
      logger.warn(`[wecom] C4 rejected (${code}, ${kind}) [group=${sessionGroup ?? ''}]: ${message}`);
      return { outcome: kind, notice: kind === 'not_stored' ? GENERIC_REJECT_REPLY : UNCERTAIN_REPLY };
    }

    if (!error) {
      logger.log(`[wecom] Sent to C4: ${content.substring(0, 80)}...`);
      return { outcome: 'sent', notice: null };
    }

    if (!neverStarted(error) || attempt >= 2) {
      logger.error(`[wecom] C4 receive failed, outcome unknown, not resending: ${stderr || error.message}`);
      return { outcome: 'uncertain', notice: UNCERTAIN_REPLY };
    }

    logger.warn(`[wecom] C4 receive did not start, retrying in ${retryDelayMs}ms: ${error.message}`);
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  }
}
