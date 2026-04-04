#!/usr/bin/env node

import path from 'path';
import dotenv from 'dotenv';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';

import { pollScanSession, startScanSession } from './lib/scan-onboard.js';

const execFileAsync = promisify(execFile);
const SERVICE_NAME = 'zylos-wecom';

dotenv.config({ path: path.join(process.env.HOME, 'zylos/.env') });

export function parseLocale(argv = process.argv, env = process.env) {
  const locale = argv.includes('--locale')
    ? argv[argv.indexOf('--locale') + 1]
    : env.LC_ALL || env.LC_MESSAGES || env.LANG || 'zh-CN';
  return String(locale).startsWith('en') ? 'en-US' : 'zh-CN';
}

export async function ensureWecomRuntimeRunning(exec = execFileAsync, env = process.env) {
  const ecosystemPath = path.join(
    env.HOME || '',
    'zylos/.claude/skills/wecom/ecosystem.config.cjs'
  );
  try {
    await exec('pm2', ['restart', SERVICE_NAME], {
      timeout: 30_000,
      env
    });
  } catch (error) {
    const stderr = String(error?.stderr || '');
    const stdout = String(error?.stdout || '');
    const combined = `${stdout}\n${stderr}`;
    if (
      !combined.includes(`Process or Namespace ${SERVICE_NAME} not found`) &&
      !combined.toLowerCase().includes('not found')
    ) {
      const message = error instanceof Error ? error.message : `failed to restart ${SERVICE_NAME}`;
      throw new Error(message);
    }

    await exec('pm2', ['start', ecosystemPath, '--only', SERVICE_NAME], {
      timeout: 30_000,
      env
    });
  }

  try {
    await exec('pm2', ['save'], {
      timeout: 30_000,
      env
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : `failed to persist ${SERVICE_NAME}`;
    throw new Error(message);
  }
}

export async function main(argv = process.argv) {
  const command = argv[2];
  const locale = parseLocale(argv);

  if (command === 'start') {
    const result = await startScanSession({ locale });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  if (command === 'poll') {
    const sessionId = argv[3];
    if (!sessionId) {
      throw new Error('sessionId is required');
    }
    const result = await pollScanSession({ locale, sessionId });
    if (result.status === 'connected') {
      await ensureWecomRuntimeRunning();
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  throw new Error('usage: node src/scan-session-cli.js <start|poll> [sessionId]');
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : 'unknown error';
    process.stdout.write(`${JSON.stringify({ status: 'error', error: message })}\n`);
    process.exit(1);
  });
}
