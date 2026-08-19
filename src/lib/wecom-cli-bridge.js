import { execFileSync } from 'child_process';

import {
  checkWecomCliAuthMatchesBot,
  createWecomCliChildEnv
} from './wecom-cli-auth.js';

const AUTH_ERROR_CODE = 893201;
const OFFICE_MESSAGE_COMMAND = 'message';
const ROUTE_LOG_PREFIX = '[zylos-wecom]';

export const EXPLICIT_OFFICE_MESSAGE_INTENT = 'explicit-office-message';

export class WecomCliAuthRequiredError extends Error {
  constructor(errorInfo, originalError) {
    super('wecom-cli authorization is required');
    this.name = 'WecomCliAuthRequiredError';
    this.errorInfo = errorInfo;
    this.originalError = originalError;
  }
}

export class WecomCliRouteViolationError extends Error {
  constructor() {
    super(
      'wecom-cli message commands require an explicit office-message request; ' +
      'use scripts/send.js for channel replies and proactive channel messages'
    );
    this.name = 'WecomCliRouteViolationError';
    this.code = 'WECOM_CLI_ROUTE_VIOLATION';
  }
}

export class WecomCliPrincipalMismatchError extends Error {
  constructor() {
    super('wecom-cli is not authorized as the configured WeCom channel Bot');
    this.name = 'WecomCliPrincipalMismatchError';
    this.code = 'WECOM_CLI_PRINCIPAL_MISMATCH';
  }
}

export function parseWecomCliError(text) {
  if (!text) return null;
  const lines = String(text).split('\n');

  // Official CLI errors are compact JSON. Parse individual lines first so
  // stderr diagnostics appended after stdout cannot invalidate the envelope.
  for (const line of lines) {
    if (!line.trim().startsWith('{')) continue;
    try {
      const payload = JSON.parse(line.trim());
      if (payload?.error && typeof payload.error === 'object') return payload.error;
    } catch {
      // Pretty-printed JSON is handled by the multiline pass below.
    }
  }

  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].trim().startsWith('{')) continue;
    try {
      const payload = JSON.parse(lines.slice(i).join('\n').trim());
      return payload?.error && typeof payload.error === 'object'
        ? payload.error
        : null;
    } catch {
      // Diagnostic text can precede the structured error. Keep scanning.
    }
  }
  return null;
}

export function runWecomCli(args, options = {}) {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
    throw new TypeError('runWecomCli: args must be an array of strings');
  }

  const {
    exec = execFileSync,
    intent,
    onRouteViolation = console.warn,
    ...execOptions
  } = options;

  const childEnv = createWecomCliChildEnv(execOptions.env || process.env);

  if (
    args[0] === OFFICE_MESSAGE_COMMAND &&
    intent !== EXPLICIT_OFFICE_MESSAGE_INTENT
  ) {
    const error = new WecomCliRouteViolationError();
    onRouteViolation(`${ROUTE_LOG_PREFIX} ${error.code}: ${error.message}`);
    throw error;
  }

  let matchesChannelBot = false;
  try {
    matchesChannelBot = checkWecomCliAuthMatchesBot(
      process.env.WECOM_BOT_ID,
      exec,
      { env: childEnv }
    );
  } catch {
    // Fail closed: a missing CLI, unreadable ledger, or malformed response must
    // never allow a business command to run.
  }
  if (!matchesChannelBot) {
    throw new WecomCliPrincipalMismatchError();
  }

  try {
    return exec('wecom-cli', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...execOptions,
      env: childEnv
    });
  } catch (error) {
    const combined = `${String(error.stdout || '')}${String(error.stderr || '')}`;
    const errorInfo = parseWecomCliError(combined);
    if (errorInfo?.type === 'AuthError' || errorInfo?.code === AUTH_ERROR_CODE) {
      throw new WecomCliAuthRequiredError(errorInfo, error);
    }
    throw error;
  }
}
