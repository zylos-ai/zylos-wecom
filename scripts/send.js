#!/usr/bin/env node
/**
 * C4 Communication Bridge Interface for zylos-wecom (WebSocket mode)
 *
 * Sends messages to WeCom via the internal HTTP API of the main process,
 * which forwards them over the WebSocket connection.
 *
 * Usage:
 *   ./send.js <endpoint_id> "message text"
 *
 * Endpoint format:
 *   userId|type:p2p|msg:msgId
 *   chatId|type:group|msg:msgId
 *
 * Exit codes:
 *   0 - Success
 *   1 - Error
 */

import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
dotenv.config({ path: path.join(process.env.HOME, 'zylos/.env') });

import { getConfig, DATA_DIR } from '../src/lib/config.js';
import { t } from '../src/lib/i18n/cli-messages.js';
import { parseLocaleArg, resolveLocale, stripLocaleArg } from '../src/lib/i18n/locale.js';

// Parse arguments
const rawArgs = process.argv.slice(2);
const config = getConfig();
const locale = resolveLocale({
  cliLocale: parseLocaleArg(rawArgs),
  configLocale: config?.message?.locale,
  envLocale: process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG
});
const args = stripLocaleArg(rawArgs);
if (args.length < 2) {
  console.error(t(locale, 'send_usage'));
  process.exit(1);
}

const rawEndpoint = args[0];
const message = args.slice(1).join(' ');

/**
 * Parse structured endpoint string.
 */
const ENDPOINT_KEYS = new Set(['type', 'msg']);

function parseEndpoint(endpoint) {
  const parts = endpoint.split('|');
  const result = { userId: parts[0] };
  for (const part of parts.slice(1)) {
    const colonIdx = part.indexOf(':');
    if (colonIdx > 0) {
      const key = part.substring(0, colonIdx);
      if (!ENDPOINT_KEYS.has(key)) continue;
      const value = part.substring(colonIdx + 1);
      result[key] = value;
    }
  }
  return result;
}

const parsedEndpoint = parseEndpoint(rawEndpoint);
const targetUser = parsedEndpoint.userId;
const msgId = parsedEndpoint.msg || '';

if (message.trim() === '[SKIP]') {
  if (!msgId) {
    process.exit(0);
  }
}

// Check if component is enabled
if (!config.enabled) {
  console.error(t(locale, 'send_disabled'));
  process.exit(1);
}

/**
 * Read internal token for authenticating with the main process.
 */
function getInternalToken() {
  try {
    return fs.readFileSync(path.join(DATA_DIR, '.internal-token'), 'utf8').trim();
  } catch {
    return '';
  }
}

/**
 * Send a request to the internal API.
 */
async function internalSend(target, msgId, content, skip = false) {
  const token = getInternalToken();
  if (!token) {
    throw new Error('Internal token not available — is the main process running?');
  }

  const port = config.internal_port || 4459;
  const body = JSON.stringify({ target, msgId, content, skip });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(`http://127.0.0.1:${port}/internal/send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Token': token,
      },
      body,
      signal: controller.signal
    });

    const result = await res.json();
    if (!result.ok) {
      throw new Error(result.error || 'Internal send returned not ok');
    }
    return true;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Record outgoing message to history.
 */
async function recordOutgoing(text) {
  const token = getInternalToken();
  if (!token) return;

  const port = config.internal_port || 4459;
  const body = JSON.stringify({
    chatId: targetUser,
    text: String(text || '').slice(0, 4000)
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    await fetch(`http://127.0.0.1:${port}/internal/record-outgoing`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Token': token,
      },
      body,
      signal: controller.signal
    });
  } catch { /* non-critical */ }
  finally {
    clearTimeout(timer);
  }
}

async function send() {
  try {
    const skip = message.trim() === '[SKIP]';
    await internalSend(targetUser, msgId, skip ? '' : message, skip);
    if (!skip) {
      await recordOutgoing(message);
    }
    console.log(t(locale, 'send_success'));
    process.exit(0);
  } catch (err) {
    console.error(t(locale, 'send_error', { message: err.message }));
    process.exit(1);
  }
}

send();
