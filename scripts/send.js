#!/usr/bin/env node
/**
 * C4 Communication Bridge Interface for zylos-wecom
 *
 * Usage:
 *   ./send.js <endpoint_id> "message text"
 *   ./send.js <endpoint_id> "[MEDIA:image]/path/to/image.png"
 *   ./send.js <endpoint_id> "[MEDIA:file]/path/to/document.pdf"
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
import { sendTextMessage, sendMarkdownMessage, sendImageMessage, sendFileMessage, uploadMedia } from '../src/lib/message.js';

const MAX_LENGTH = 2000; // WeCom text message max length

// Parse arguments
const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('Usage: send.js <endpoint_id> <message>');
  console.error('       send.js <endpoint_id> "[MEDIA:image]/path/to/image.png"');
  console.error('       send.js <endpoint_id> "[MEDIA:file]/path/to/file.pdf"');
  process.exit(1);
}

const rawEndpoint = args[0];
const message = args.slice(1).join(' ');

/**
 * Parse structured endpoint string.
 * Format: userId|type:p2p|msg:messageId
 * Backward compatible: plain userId without | works as before.
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

if (message.trim() === '[SKIP]') {
  process.exit(0);
}

// Check if component is enabled
const config = getConfig();
if (!config.enabled) {
  console.error('Error: wecom is disabled in config');
  process.exit(1);
}

// Parse media prefix
const mediaMatch = message.match(/^\[MEDIA:(\w+)\](.+)$/);

/**
 * Split long message into chunks (markdown-aware).
 * Ensures code blocks (```) are not split across chunks.
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

    // Check if we're inside a code block at the break point
    const segment = remaining.substring(0, breakAt);
    const fenceMatches = segment.match(/```/g);
    const insideCodeBlock = fenceMatches && fenceMatches.length % 2 !== 0;

    if (insideCodeBlock) {
      // Find the start of this unclosed code block and break before it
      const lastFenceStart = segment.lastIndexOf('```');
      const lineBeforeFence = remaining.lastIndexOf('\n', lastFenceStart - 1);
      if (lineBeforeFence > maxLength * 0.2) {
        breakAt = lineBeforeFence;
      } else {
        // Code block is too large; find its end and include the whole block
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

      // Prefer breaking at double newline (paragraph boundary)
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
 * Check if text contains markdown formatting worth rendering as markdown.
 */
function hasMarkdownContent(text) {
  if (/```/.test(text)) return true;
  if (/^#{1,6}\s/m.test(text)) return true;
  if (/\*\*[^*]+\*\*/.test(text)) return true;
  if (/^[\s]*[-*]\s/m.test(text) || /^[\s]*\d+\.\s/m.test(text)) return true;
  if (/\|.+\|/.test(text) && /^[\s]*\|[\s]*[-:]+/m.test(text)) return true;
  return false;
}

/**
 * Notify index.js to record the bot's outgoing message into in-memory history.
 */
async function recordOutgoing(text) {
  let internalSecret = process.env.WECOM_INTERNAL_SECRET;
  if (!internalSecret) {
    // Fallback: read token from file (written by index.js at startup)
    try {
      internalSecret = fs.readFileSync(path.join(DATA_DIR, '.internal-token'), 'utf8').trim();
    } catch {}
  }
  if (!internalSecret) {
    console.warn('[wecom] Warning: internal secret not available -- record-outgoing will be rejected');
    return;
  }
  const port = (config.webhook_port || 3459) + 1000;
  const safeText = String(text || '').slice(0, 4000);
  const body = JSON.stringify({
    chatId: targetUser,
    text: safeText
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    await fetch(`http://127.0.0.1:${port}/internal/record-outgoing`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Token': internalSecret,
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
 * When useMarkdownCard is enabled and text contains markdown, sends as markdown message.
 */
async function sendText(userId, text) {
  const useMarkdown = config.message?.useMarkdownCard && hasMarkdownContent(text);
  const chunks = splitMessage(text, MAX_LENGTH);

  for (let i = 0; i < chunks.length; i++) {
    let result;

    if (useMarkdown) {
      result = await sendMarkdownMessage(userId, chunks[i]);
      // Fall back to plain text if markdown sending fails
      if (!result.success) {
        console.log('[wecom] Markdown send failed, falling back to text:', result.message);
        result = await sendTextMessage(userId, chunks[i]);
      }
    } else {
      result = await sendTextMessage(userId, chunks[i]);
    }

    if (!result.success) {
      throw new Error(result.message);
    }

    // Small delay between chunks
    if (i < chunks.length - 1) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  if (chunks.length > 1) {
    console.log(`Sent ${chunks.length} chunks`);
  }
}

/**
 * Send media (image or file).
 */
async function sendMedia(type, filePath) {
  const trimmedPath = filePath.trim();

  if (type === 'image') {
    const uploadResult = await uploadMedia(trimmedPath, 'image');
    if (!uploadResult.success) {
      throw new Error(`Failed to upload image: ${uploadResult.message}`);
    }
    const sendResult = await sendImageMessage(targetUser, uploadResult.mediaId);
    if (!sendResult.success) {
      throw new Error(`Failed to send image: ${sendResult.message}`);
    }
  } else if (type === 'file') {
    const uploadResult = await uploadMedia(trimmedPath, 'file');
    if (!uploadResult.success) {
      throw new Error(`Failed to upload file: ${uploadResult.message}`);
    }
    const sendResult = await sendFileMessage(targetUser, uploadResult.mediaId);
    if (!sendResult.success) {
      throw new Error(`Failed to send file: ${sendResult.message}`);
    }
  } else {
    throw new Error(`Unsupported media type: ${type}`);
  }
}

async function send() {
  try {
    if (mediaMatch) {
      const [, mediaType, mediaPath] = mediaMatch;
      await sendMedia(mediaType, mediaPath);
      await recordOutgoing(mediaType === 'image' ? '[sent image]' : '[sent file]');
    } else {
      await sendText(targetUser, message);
      await recordOutgoing(message);
    }
    console.log('Message sent successfully');
    process.exit(0);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

send();
