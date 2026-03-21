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

const MAX_LENGTH = 2000; // WeCom text message max length

// Parse arguments
const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('Usage: send.js <endpoint_id> <message>');
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
  process.exit(0);
}

// Check if component is enabled
const config = getConfig();
if (!config.enabled) {
  console.error('Error: wecom is disabled in config');
  process.exit(1);
}

/**
 * Split long message into chunks (markdown-aware).
 */
function splitMessage(text, maxLength) {
  if (text.length <= maxLength) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      const finalChunk = remaining.trim();
      if (finalChunk.length > 0) {
        chunks.push(finalChunk);
      }
      break;
    }

    let breakAt = maxLength;

    const segment = remaining.substring(0, breakAt);
    const fenceMatches = segment.match(/```/g);
    const insideCodeBlock = fenceMatches && fenceMatches.length % 2 !== 0;

    if (insideCodeBlock) {
      const lastFenceStart = segment.lastIndexOf('```');
      const lineBeforeFence = remaining.lastIndexOf('\n', lastFenceStart - 1);
      if (lineBeforeFence > maxLength * 0.2) {
        breakAt = lineBeforeFence;
      } else {
        const fenceEnd = remaining.indexOf('```', lastFenceStart + 3);
        if (fenceEnd !== -1) {
          const blockEnd = remaining.indexOf('\n', fenceEnd + 3);
          breakAt = blockEnd !== -1 ? blockEnd + 1 : fenceEnd + 3;
        }
        if (breakAt > maxLength) {
          breakAt = maxLength;
        }
      }
    } else {
      const chunk = remaining.substring(0, breakAt);
      const lastParaBreak = chunk.lastIndexOf('\n\n');
      if (lastParaBreak > maxLength * 0.3) {
        breakAt = lastParaBreak + 1;
      } else {
        const lastNewline = chunk.lastIndexOf('\n');
        if (lastNewline > maxLength * 0.3) {
          breakAt = lastNewline;
        } else {
          const lastSpace = chunk.lastIndexOf(' ');
          if (lastSpace > maxLength * 0.3) {
            breakAt = lastSpace;
          }
        }
      }
    }

    const nextChunk = remaining.substring(0, breakAt).trim();
    if (nextChunk.length > 0) {
      chunks.push(nextChunk);
    }
    remaining = remaining.substring(breakAt).trim();
  }

  return chunks;
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
async function internalSend(target, msgId, content) {
  const token = getInternalToken();
  if (!token) {
    throw new Error('Internal token not available — is the main process running?');
  }

  const port = config.internal_port || 4459;
  const body = JSON.stringify({ target, msgId, content });

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
      throw new Error('Internal send returned not ok');
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

/**
 * Send text message with auto-chunking.
 */
async function sendText(target, msgId, text) {
  const chunks = splitMessage(text, MAX_LENGTH);

  for (let i = 0; i < chunks.length; i++) {
    // For the first chunk, use the original msgId (enables reply mode)
    // For subsequent chunks, no msgId (proactive send)
    const chunkMsgId = i === 0 ? msgId : '';
    await internalSend(target, chunkMsgId, chunks[i]);

    // Small delay between chunks
    if (i < chunks.length - 1) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  if (chunks.length > 1) {
    console.log(`Sent ${chunks.length} chunks`);
  }
}

async function send() {
  try {
    await sendText(targetUser, msgId, message);
    await recordOutgoing(message);
    console.log('Message sent successfully');
    process.exit(0);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

send();
