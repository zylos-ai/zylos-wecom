import { execFileSync } from 'child_process';

const AUTH_ERROR_CODE = 893201;

export class WecomCliAuthRequiredError extends Error {
  constructor(errorInfo, originalError) {
    super('wecom-cli authorization is required');
    this.name = 'WecomCliAuthRequiredError';
    this.errorInfo = errorInfo;
    this.originalError = originalError;
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

  const { exec = execFileSync, ...execOptions } = options;
  try {
    return exec('wecom-cli', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...execOptions
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
