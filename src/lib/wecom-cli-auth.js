import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFileSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';

import { DATA_DIR } from './config.js';

const AUTH_PAGE_ORIGIN = 'https://work.weixin.qq.com';
const AUTH_PAGE_PATH = '/ai/qc/gen';
const SESSION_TTL_MS = 6 * 60 * 1000;
const REPLY_ENDPOINT_TTL_MS = 10 * 60 * 1000;
const ENDPOINT_LOG_PREFIX = '[zylos-wecom]';
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const MANUAL_AUTH_HELPER = path.resolve(MODULE_DIR, '../../scripts/wecom-cli-manual-auth-pty.py');

export function createWecomCliChildEnv(env = process.env) {
  const childEnv = { ...env };
  delete childEnv.WECOM_BOT_ID;
  delete childEnv.WECOM_BOT_SECRET;
  return childEnv;
}

export class WecomCliAuthFlowError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WecomCliAuthFlowError';
    this.code = code;
  }
}

export function parseWecomReplyEndpoint(endpoint) {
  if (typeof endpoint !== 'string' || endpoint.length > 1024) {
    throw new WecomCliAuthFlowError('invalid_endpoint', 'A WeCom reply endpoint is required');
  }

  const parts = endpoint.split('|');
  const userId = parts.shift();
  if (!userId || /[\s\x00-\x1f]/.test(userId)) {
    throw new WecomCliAuthFlowError('invalid_endpoint', 'Invalid WeCom endpoint user');
  }

  const parsed = { userId, type: '', msg: '' };
  const seen = new Set();
  for (const part of parts) {
    const separator = part.indexOf(':');
    if (separator < 1) {
      throw new WecomCliAuthFlowError('invalid_endpoint', 'Invalid WeCom endpoint field');
    }
    const key = part.slice(0, separator);
    const value = part.slice(separator + 1);
    if (!['type', 'msg'].includes(key) || seen.has(key) || !value) {
      throw new WecomCliAuthFlowError('invalid_endpoint', 'Invalid WeCom endpoint field');
    }
    if (/[\r\n\x00]/.test(value)) {
      throw new WecomCliAuthFlowError('invalid_endpoint', 'Invalid WeCom endpoint value');
    }
    seen.add(key);
    parsed[key] = value;
  }

  if (parsed.type !== 'p2p' || !parsed.msg) {
    throw new WecomCliAuthFlowError(
      'owner_dm_required',
      'CLI authorization requires an originating WeCom private message'
    );
  }
  return parsed;
}

export function assertOwnerDm(endpoint, config) {
  const parsed = parseWecomReplyEndpoint(endpoint);
  if (!config?.owner?.bound || String(config.owner.user_id) !== parsed.userId) {
    throw new WecomCliAuthFlowError(
      'owner_dm_required',
      'CLI authorization is restricted to the configured WeCom owner'
    );
  }
  return parsed;
}

function endpointRecordPath(endpoint, rootDir) {
  const digest = crypto.createHash('sha256').update(endpoint).digest('hex');
  return path.join(rootDir, `${digest}.json`);
}

export function recordOwnerReplyEndpoint(endpoint, config, options = {}) {
  const parsed = assertOwnerDm(endpoint, config);
  const rootDir = options.rootDir || path.join(DATA_DIR, 'reply-endpoints');
  const now = options.now ?? Date.now();
  fs.mkdirSync(rootDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(rootDir, 0o700);

  for (const name of fs.readdirSync(rootDir)) {
    if (!name.endsWith('.json')) continue;
    const candidatePath = path.join(rootDir, name);
    try {
      const record = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
      if (
        !Number.isFinite(record.receivedAt) ||
        now < record.receivedAt ||
        now - record.receivedAt > REPLY_ENDPOINT_TTL_MS
      ) {
        fs.rmSync(candidatePath, { force: true });
      }
    } catch {
      fs.rmSync(candidatePath, { force: true });
    }
  }

  const recordPath = endpointRecordPath(endpoint, rootDir);
  const tempPath = `${recordPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tempPath, JSON.stringify({ endpoint, receivedAt: now }), {
      mode: 0o600,
      flag: 'wx'
    });
    fs.renameSync(tempPath, recordPath);
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
  return parsed;
}

export function consumeOwnerReplyEndpoint(endpoint, config, options = {}) {
  const onViolation = options.onViolation || console.warn;
  const reject = (message) => {
    const error = new WecomCliAuthFlowError('untrusted_endpoint', message);
    onViolation(`${ENDPOINT_LOG_PREFIX} WECOM_ENDPOINT_PROVENANCE_VIOLATION: ${error.message}`);
    throw error;
  };

  let parsed;
  try {
    parsed = assertOwnerDm(endpoint, config);
  } catch (error) {
    onViolation(
      `${ENDPOINT_LOG_PREFIX} WECOM_ENDPOINT_PROVENANCE_VIOLATION: ${error.message}`
    );
    throw error;
  }

  const rootDir = options.rootDir || path.join(DATA_DIR, 'reply-endpoints');
  const recordPath = endpointRecordPath(endpoint, rootDir);
  const claimPath = `${recordPath}.claimed-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.renameSync(recordPath, claimPath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      reject('Endpoint was not issued by the WeCom server reply path');
    }
    throw error;
  }

  try {
    let record;
    try {
      record = JSON.parse(fs.readFileSync(claimPath, 'utf8'));
    } catch {
      reject('Endpoint provenance record is invalid');
    }
    const now = options.now ?? Date.now();
    if (
      record.endpoint !== endpoint ||
      !Number.isFinite(record.receivedAt) ||
      now < record.receivedAt ||
      now - record.receivedAt > REPLY_ENDPOINT_TTL_MS
    ) {
      reject('Endpoint provenance record is invalid or expired');
    }
    return parsed;
  } finally {
    fs.rmSync(claimPath, { force: true });
  }
}

export function extractWecomAuthPageUrl(output) {
  const matches = String(output || '').match(/https:\/\/work\.weixin\.qq\.com\/ai\/qc\/gen\?[^\s]+/g);
  if (!matches) return null;

  for (const candidate of matches) {
    try {
      const url = new URL(candidate);
      if (url.origin === AUTH_PAGE_ORIGIN && url.pathname === AUTH_PAGE_PATH) {
        return url.toString();
      }
    } catch {
      // Ignore malformed diagnostic text.
    }
  }
  return null;
}

export function sendWecomC4(endpoint, message, options = {}) {
  const spawnImpl = options.spawnImpl || spawn;
  const c4SendPath = options.c4SendPath || path.join(
    process.env.HOME || '',
    'zylos/.claude/skills/comm-bridge/scripts/c4-send.js'
  );

  return new Promise((resolve, reject) => {
    const child = spawnImpl('node', [c4SendPath, 'wecom', endpoint], {
      stdio: ['pipe', 'ignore', 'pipe']
    });
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-4000);
    });
    child.on('error', () => {
      reject(new WecomCliAuthFlowError('delivery_failed', 'Unable to start C4 delivery'));
    });
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new WecomCliAuthFlowError(
        'delivery_failed',
        `WeCom delivery failed${stderr ? `: ${stderr.trim()}` : ''}`
      ));
    });
    child.stdin.end(String(message));
  });
}

export function runOfficialWecomCliAuth(options) {
  const spawnImpl = options.spawnImpl || spawn;
  const qrFileName = path.basename(options.qrPath);

  return new Promise((resolve, reject) => {
    const child = spawnImpl('wecom-cli', [
      'auth',
      'init',
      '--noninteractive',
      '--no-browser',
      '--output-qrcode',
      qrFileName
    ], {
      cwd: options.cwd,
      env: createWecomCliChildEnv(options.env || process.env),
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let output = '';
    let pageUrl = null;
    let qrReady = false;
    let deliveryPromise = null;

    const maybeDeliver = () => {
      if (deliveryPromise || !pageUrl || !qrReady || !fs.existsSync(options.qrPath)) return;
      deliveryPromise = Promise.resolve().then(
        () => options.onReady({ pageUrl, qrPath: options.qrPath })
      );
      deliveryPromise.catch(() => child.kill());
    };

    const consume = (chunk) => {
      output = `${output}${chunk}`.slice(-32768);
      pageUrl = pageUrl || extractWecomAuthPageUrl(output);
      if (output.includes('二维码已保存到:')) qrReady = true;
      maybeDeliver();
    };

    child.stdout.on('data', consume);
    child.stderr.on('data', consume);
    child.on('error', () => {
      reject(new WecomCliAuthFlowError('cli_start_failed', 'Unable to start wecom-cli auth'));
    });
    child.on('close', async (code) => {
      try {
        if (deliveryPromise) await deliveryPromise;
        if (code !== 0) {
          throw new WecomCliAuthFlowError(
            code === 1 ? 'auth_failed_or_expired' : 'cli_failed',
            'WeCom CLI authorization did not complete'
          );
        }
        if (!deliveryPromise) {
          throw new WecomCliAuthFlowError(
            'auth_material_missing',
            'wecom-cli did not produce authorization material'
          );
        }
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
}

/**
 * Authorize the official CLI with the already-configured WebSocket Bot.
 * Credentials travel only over the helper's stdin and PTY; they are never
 * placed in argv, environment variables, output, or logs.
 */
export function runOfficialWecomCliManualAuth(options) {
  const spawnImpl = options.spawnImpl || spawn;
  const botId = String(options.botId || '');
  const secret = String(options.secret || '');
  if (!botId || !secret || /[\r\n]/.test(botId) || /[\r\n]/.test(secret)) {
    return Promise.reject(new WecomCliAuthFlowError(
      'bot_credentials_missing',
      'Existing WeCom Bot credentials are required'
    ));
  }

  return new Promise((resolve, reject) => {
    const child = spawnImpl(options.pythonPath || 'python3', [
      options.helperPath || MANUAL_AUTH_HELPER
    ], {
      env: createWecomCliChildEnv(options.env || process.env),
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    child.stdout?.on('data', (chunk) => {
      stdout = `${stdout}${chunk}`.slice(-4096);
    });
    child.stderr?.resume?.();
    child.on('error', () => reject(new WecomCliAuthFlowError(
      'cli_start_failed',
      'Unable to start the secure WeCom CLI manual auth helper'
    )));
    child.on('close', (code) => {
      let result = null;
      try {
        result = JSON.parse(stdout.trim());
      } catch {}
      if (code === 0 && result?.ok === true && result.status === 'authorized') {
        resolve();
        return;
      }
      reject(new WecomCliAuthFlowError(
        result?.error || 'auth_failed_or_expired',
        'WeCom CLI manual authorization did not complete'
      ));
    });
    child.stdin.end(`${JSON.stringify({
      bot_id: botId,
      secret,
      cli_path: options.cliPath || 'wecom-cli',
      timeout_seconds: options.timeoutSeconds || 30
    })}\n`);
  });
}

export function checkWecomCliAuthStatus(exec = execFileSync, options = {}) {
  const output = exec('wecom-cli', ['auth', 'show', '--status'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: createWecomCliChildEnv(options.env || process.env)
  }).trim();
  return output === 'authorized';
}

export function checkWecomCliAuthMatchesBot(expectedBotId, exec = execFileSync, options = {}) {
  if (!expectedBotId) return false;
  const output = exec('wecom-cli', ['auth', 'show'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: createWecomCliChildEnv(options.env || process.env)
  });
  const status = String(output).match(/^Status:\s*(\S+)\s*$/m)?.[1];
  const botId = String(output).match(/^Bot ID:\s*(\S+)\s*$/m)?.[1];
  return status === 'authorized' && botId === expectedBotId;
}

function acquireLock(rootDir, now = Date.now()) {
  fs.mkdirSync(rootDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(rootDir, 0o700);
  const lockPath = path.join(rootDir, 'active.lock');

  const open = () => {
    const fd = fs.openSync(lockPath, 'wx', 0o600);
    fs.writeFileSync(fd, `${process.pid} ${now}\n`);
    fs.closeSync(fd);
  };

  try {
    open();
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const age = now - fs.statSync(lockPath).mtimeMs;
    if (age <= SESSION_TTL_MS) {
      throw new WecomCliAuthFlowError('auth_in_progress', 'A WeCom CLI auth session is already active');
    }
    fs.unlinkSync(lockPath);
    open();
  }

  return lockPath;
}

export async function authorizeWecomCli(options) {
  const endpoint = options.endpoint;
  const consumeEndpoint = options.consumeEndpoint || consumeOwnerReplyEndpoint;
  consumeEndpoint(endpoint, options.config, {
    rootDir: options.provenanceRoot,
    now: options.now,
    onViolation: options.onEndpointViolation
  });

  const rootDir = options.tempRoot || path.join(DATA_DIR, 'cli-auth');
  const lockPath = acquireLock(rootDir, options.now);
  let sessionDir = null;
  const sendMessage = options.sendMessage || sendWecomC4;
  const runAuth = options.runAuth || runOfficialWecomCliAuth;
  const checkStatus = options.checkStatus || checkWecomCliAuthStatus;

  try {
    sessionDir = fs.mkdtempSync(path.join(rootDir, 'session-'));
    fs.chmodSync(sessionDir, 0o700);
    const qrPath = path.join(sessionDir, 'qrcode.png');
    await runAuth({
      cwd: sessionDir,
      qrPath,
      onReady: async ({ pageUrl, qrPath: readyQrPath }) => {
        await sendMessage(
          endpoint,
          `企业微信 CLI 需要 owner 授权。请在 5 分钟内打开官方链接确认：\n${pageUrl}`
        );
        await sendMessage(endpoint, `[MEDIA:image]${readyQrPath}`);
      }
    });

    if (!checkStatus()) {
      throw new WecomCliAuthFlowError('status_not_authorized', 'wecom-cli did not report authorized');
    }

    await sendMessage(endpoint, '企业微信 CLI 授权成功，正在重试刚才的操作。');
    return { ok: true, status: 'authorized', retryOriginalOperation: true };
  } catch (error) {
    if (error.code !== 'delivery_failed') {
      await sendMessage(
        endpoint,
        '企业微信 CLI 授权未完成或已超时。需要时请在当前私聊重新发起。'
      ).catch(() => {});
    }
    throw error;
  } finally {
    if (sessionDir) fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(lockPath, { force: true });
  }
}
