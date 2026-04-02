#!/usr/bin/env node

import path from 'path';
import dotenv from 'dotenv';
import { execFile } from 'child_process';
import { promisify } from 'util';

import { pollScanSession, startScanSession } from './lib/scan-onboard.js';

const execFileAsync = promisify(execFile);

dotenv.config({ path: path.join(process.env.HOME, 'zylos/.env') });

function parseLocale() {
  const locale = process.argv.includes('--locale')
    ? process.argv[process.argv.indexOf('--locale') + 1]
    : process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || 'zh-CN';
  return String(locale).startsWith('en') ? 'en-US' : 'zh-CN';
}

async function restartWecomRuntime() {
  try {
    await execFileAsync('pm2', ['restart', 'zylos-wecom'], {
      timeout: 30_000,
      env: process.env
    });
    await execFileAsync('pm2', ['save'], {
      timeout: 30_000,
      env: process.env
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'failed to restart zylos-wecom';
    throw new Error(message);
  }
}

async function main() {
  const command = process.argv[2];
  const locale = parseLocale();

  if (command === 'start') {
    const result = await startScanSession({ locale });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  if (command === 'poll') {
    const sessionId = process.argv[3];
    if (!sessionId) {
      throw new Error('sessionId is required');
    }
    const result = await pollScanSession({ locale, sessionId });
    if (result.status === 'connected') {
      await restartWecomRuntime();
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  throw new Error('usage: node src/scan-session-cli.js <start|poll> [sessionId]');
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : 'unknown error';
  process.stdout.write(`${JSON.stringify({ status: 'error', error: message })}\n`);
  process.exit(1);
});
