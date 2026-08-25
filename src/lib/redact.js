/**
 * Sensitive-field redaction for logging.
 *
 * WeCom frames (inbound media handles, outbound upload/subscribe frames,
 * signed COS download URLs) carry secrets that must never reach the logs in
 * plaintext: AES media keys, bot secrets, access/refresh tokens, and the
 * `sign` / `q-signature` / `q-ak` query params on Tencent COS signed URLs.
 * Outbound `aibot_upload_media_chunk` frames additionally carry the raw file/
 * image bytes as a `base64_data` blob — recoverable content and huge log
 * lines — which is masked down to a size summary.
 *
 * `redact(value)` returns a deep copy with those values masked. The original
 * object is never mutated so callers can safely pass live frames.
 */

// Object keys (case-insensitive, substring match) whose values are secrets.
// `token` also covers access_token / refresh_token; the explicit entries make
// the intent obvious and are harmless.
const SENSITIVE_KEY_PATTERNS = [
  'secret',
  'aeskey',
  'apikey',
  'api_key',
  'access_token',
  'refresh_token',
  'token',
  'authorization',
  'password'
];

// Bulk binary payload keys (case-insensitive, substring match). Their values
// are large base64/binary blobs — e.g. `base64_data` on outbound
// `aibot_upload_media_chunk` frames carries the raw file/image content. These
// are not "secrets" by name but must never reach the logs verbatim: the
// content is recoverable and the lines are huge. Their value is replaced with
// a size summary instead of the payload, so a log still shows a chunk was sent
// and how big it was, without the bytes themselves.
const BULK_PAYLOAD_KEY_PATTERNS = ['base64'];

// Signed-URL query params whose values are secrets. Matches the explicit
// COS/signing params (sign, q-signature, q-ak, apikey) plus any param whose
// name contains secret / token / aeskey. Only the value is masked; the base
// URL and the param names are preserved so logs stay useful.
const URL_SECRET_PARAM_RE =
  /([?&])((?:sign|q-signature|q-ak|apikey)|[a-z0-9_.\-]*(?:secret|token|aeskey)[a-z0-9_.\-]*)=([^&#\s]*)/gi;

const REDACTED = '***';

export function isSensitiveKey(key) {
  const lowered = String(key).toLowerCase();
  return SENSITIVE_KEY_PATTERNS.some((pattern) => lowered.includes(pattern));
}

export function isBulkPayloadKey(key) {
  const lowered = String(key).toLowerCase();
  return BULK_PAYLOAD_KEY_PATTERNS.some((pattern) => lowered.includes(pattern));
}

/**
 * Summary marker for a redacted bulk payload: hides the content but keeps the
 * size for diagnostics. Non-string payloads fall back to the plain marker.
 */
function redactBulkPayload(value) {
  if (typeof value === 'string') {
    return `${REDACTED}(${value.length} base64 chars)`;
  }
  return REDACTED;
}

/**
 * Mask secret query-param values inside any string (e.g. a signed COS URL).
 * Non-URL strings without matching params are returned unchanged.
 */
export function redactString(value) {
  const str = String(value);
  return str.replace(URL_SECRET_PARAM_RE, (_match, sep, name) => `${sep}${name}=${REDACTED}`);
}

function deepRedact(value, seen) {
  if (typeof value === 'string') {
    return redactString(value);
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (seen.has(value)) {
    return '[Circular]';
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => deepRedact(item, seen));
  }

  const out = {};
  for (const [key, val] of Object.entries(value)) {
    if (isSensitiveKey(key)) {
      out[key] = REDACTED;
    } else if (isBulkPayloadKey(key)) {
      out[key] = redactBulkPayload(val);
    } else {
      out[key] = deepRedact(val, seen);
    }
  }
  return out;
}

/**
 * Return a redacted deep copy of `value`. Sensitive object keys are replaced
 * with `***`, and secret query params inside string values are masked. The
 * input is never mutated.
 */
export function redact(value) {
  return deepRedact(value, new WeakSet());
}

/**
 * Convenience: redact then JSON-stringify, for a single log line. Falls back
 * to a safe marker if the value cannot be serialized (never emits raw text
 * that might contain a secret).
 */
export function redactJson(value) {
  try {
    return JSON.stringify(redact(value));
  } catch {
    return '[unserializable frame]';
  }
}
