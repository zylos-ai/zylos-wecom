import os from 'os';
import fs from 'fs';
import crypto from 'crypto';
import path from 'path';

import QRCode from 'qrcode';

import { t } from './i18n/cli-messages.js';
import { SCAN_SESSION_PATH, saveCredentialsToEnv } from './config.js';

const QR_POLL_INTERVAL_MS = 3000;
const QR_POLL_TIMEOUT_MS = 5 * 60 * 1000;
const QR_SOURCE = 'wecom-cli';
const QR_QUERY_URL = 'https://work.weixin.qq.com/ai/qc/query_result';
const QR_CODE_PAGE = 'https://work.weixin.qq.com/ai/qc/gen?source=wecom-cli&scode=';
const SESSION_ID_PREFIX = 'wcs_';

export function getPlatformCode(platform = os.platform()) {
  switch (platform) {
    case 'darwin':
      return 1;
    case 'win32':
      return 2;
    case 'linux':
      return 3;
    default:
      return 0;
  }
}

export function buildGenerateUrl(platform = os.platform()) {
  const query = new URLSearchParams({
    source: QR_SOURCE,
    plat: String(getPlatformCode(platform))
  });
  return `https://work.weixin.qq.com/ai/qc/generate?${query.toString()}`;
}

function buildQueryUrl(scode) {
  const query = new URLSearchParams({ scode });
  return `${QR_QUERY_URL}?${query.toString()}`;
}

function readJsonResponse(body, locale, key) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(t(locale, key));
  }
  return parsed;
}

async function fetchJson(url, locale, parseErrorKey) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(t(locale, 'scan_http_error', { status: response.status }));
  }
  return readJsonResponse(await response.text(), locale, parseErrorKey);
}

async function renderQRCode(url) {
  return QRCode.toString(url, { type: 'terminal', small: true });
}

async function renderQRCodePngBase64(url) {
  const buffer = await QRCode.toBuffer(url, { type: 'png', width: 512, margin: 1 });
  return buffer.toString('base64');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchQRCode(locale) {
  const response = await fetchJson(buildGenerateUrl(), locale, 'scan_generate_parse_error');
  const scode = String(response?.data?.scode || '').trim();
  const authUrl = String(response?.data?.auth_url || '').trim();
  if (!scode || !authUrl) {
    throw new Error(t(locale, 'scan_generate_missing_fields'));
  }
  return { scode, authUrl };
}

function readStatus(response) {
  return String(response?.data?.status || '').trim().toLowerCase();
}

export async function scanQRCodeForBotInfo({
  locale = 'zh-CN',
  logger = console,
  pollIntervalMs = QR_POLL_INTERVAL_MS,
  pollTimeoutMs = QR_POLL_TIMEOUT_MS
} = {}) {
  logger.log(t(locale, 'scan_fetching_qr'));
  const { scode, authUrl } = await fetchQRCode(locale);

  logger.log(t(locale, 'scan_prompt'));
  logger.log('');
  logger.log(await renderQRCode(authUrl));
  logger.log(t(locale, 'scan_alt_url', { url: `${QR_CODE_PAGE}${scode}` }));
  logger.log(t(locale, 'scan_waiting'));

  const startedAt = Date.now();
  while (Date.now() - startedAt < pollTimeoutMs) {
    const response = await fetchJson(buildQueryUrl(scode), locale, 'scan_query_parse_error');
    const status = readStatus(response);

    if (status === 'success') {
      const botId = String(response?.data?.bot_info?.botid || '').trim();
      const secret = String(response?.data?.bot_info?.secret || '').trim();
      if (!botId || !secret) {
        throw new Error(t(locale, 'scan_missing_bot_info'));
      }

      logger.log(t(locale, 'scan_success'));
      return { botId, secret };
    }

    if (['denied', 'cancelled', 'expired', 'error', 'failed'].includes(status)) {
      throw new Error(t(locale, 'scan_terminal_status', { status }));
    }

    await sleep(pollIntervalMs);
  }

  throw new Error(t(locale, 'scan_timeout'));
}

function writeJsonFile(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, filePath);
}

function readJsonFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

export function readScanSession(sessionPath = SCAN_SESSION_PATH) {
  try {
    if (!fs.existsSync(sessionPath)) {
      return null;
    }
    return readJsonFile(sessionPath);
  } catch {
    return null;
  }
}

export function clearScanSession(sessionPath = SCAN_SESSION_PATH) {
  try {
    fs.unlinkSync(sessionPath);
  } catch {
    // ignore
  }
}

export async function startScanSession({
  locale = 'zh-CN',
  sessionPath = SCAN_SESSION_PATH,
  now = Date.now()
} = {}) {
  const { scode, authUrl } = await fetchQRCode(locale);
  const sessionId = `${SESSION_ID_PREFIX}${crypto.randomUUID().replace(/-/g, '')}`;
  const expiresAtMs = now + QR_POLL_TIMEOUT_MS;
  const session = {
    sessionId,
    scode,
    authUrl,
    status: 'qr_ready',
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString()
  };

  writeJsonFile(sessionPath, session);

  return {
    status: 'qr_ready',
    sessionId,
    scode,
    authUrl,
    qrImage: await renderQRCodePngBase64(authUrl),
    expiresInSec: Math.max(0, Math.floor((expiresAtMs - now) / 1000))
  };
}

export async function pollScanSession({
  sessionId,
  locale = 'zh-CN',
  sessionPath = SCAN_SESSION_PATH,
  now = Date.now(),
  persistCredentials = saveCredentialsToEnv
} = {}) {
  const session = readScanSession(sessionPath);
  if (!session || !session.sessionId) {
    return { status: 'error', error: t(locale, 'scan_session_missing') };
  }
  if (sessionId && session.sessionId !== sessionId) {
    return { status: 'error', error: t(locale, 'scan_session_mismatch') };
  }

  const expiresAtMs = Date.parse(session.expiresAt || '');
  if (Number.isFinite(expiresAtMs) && now >= expiresAtMs) {
    clearScanSession(sessionPath);
    return { status: 'expired' };
  }

  const response = await fetchJson(buildQueryUrl(session.scode), locale, 'scan_query_parse_error');
  const status = readStatus(response);
  const expiresInSec = Number.isFinite(expiresAtMs)
    ? Math.max(0, Math.floor((expiresAtMs - now) / 1000))
    : 0;

  if (status === 'success') {
    const botId = String(response?.data?.bot_info?.botid || '').trim();
    const secret = String(response?.data?.bot_info?.secret || '').trim();
    if (!botId || !secret) {
      return { status: 'error', error: t(locale, 'scan_missing_bot_info') };
    }

    persistCredentials({ bot_id: botId, secret });
    clearScanSession(sessionPath);
    return {
      status: 'connected',
      botId,
      botSecret: secret
    };
  }

  if (['denied', 'cancelled', 'expired', 'error', 'failed'].includes(status)) {
    clearScanSession(sessionPath);
    return {
      status: 'error',
      error: t(locale, 'scan_terminal_status', { status })
    };
  }

  writeJsonFile(sessionPath, {
    ...session,
    lastPolledAt: new Date(now).toISOString()
  });

  return {
    status: session.status || 'qr_ready',
    expiresInSec
  };
}
