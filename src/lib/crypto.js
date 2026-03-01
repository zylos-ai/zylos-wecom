/**
 * WeCom Message Encryption/Decryption
 *
 * WeCom uses a specific encryption scheme:
 * 1. Signature verification: SHA1(sort([token, timestamp, nonce, encrypted_msg]))
 * 2. Decryption: Base64 decode encrypted_msg -> AES-256-CBC decrypt
 * 3. Key derivation: Base64Decode(EncodingAESKey + "=") -> 32 bytes
 * 4. IV: first 16 bytes of the derived key
 * 5. Plaintext layout: 16 bytes random + 4 bytes msg_len (network byte order) + msg + corp_id
 *
 * Reference: https://developer.work.weixin.qq.com/document/path/90968
 */

import crypto from 'crypto';

/**
 * Derive the AES key and IV from EncodingAESKey.
 * EncodingAESKey is a 43-character base64-encoded string.
 * Append "=" to get standard base64, then decode to get 32 bytes.
 * IV is the first 16 bytes of the key.
 *
 * @param {string} encodingAESKey - 43-character base64 string
 * @returns {{ key: Buffer, iv: Buffer }}
 */
export function deriveKeyIV(encodingAESKey) {
  if (!encodingAESKey || encodingAESKey.length !== 43) {
    throw new Error(`Invalid EncodingAESKey length: expected 43, got ${encodingAESKey?.length || 0}`);
  }
  const key = Buffer.from(encodingAESKey + '=', 'base64');
  if (key.length !== 32) {
    throw new Error(`Derived key length invalid: expected 32, got ${key.length}`);
  }
  const iv = key.subarray(0, 16);
  return { key, iv };
}

/**
 * Compute SHA1 signature for WeCom callback verification.
 * Sort the parameters alphabetically, concatenate, and SHA1 hash.
 *
 * @param {string} token - Callback verification token
 * @param {string} timestamp - Timestamp string
 * @param {string} nonce - Nonce string
 * @param {string} encrypted - Encrypted message string (may be empty for URL verification)
 * @returns {string} Hex-encoded SHA1 hash
 */
export function computeSignature(token, timestamp, nonce, encrypted = '') {
  const params = [token, timestamp, nonce];
  if (encrypted) params.push(encrypted);
  params.sort();
  const str = params.join('');
  return crypto.createHash('sha1').update(str).digest('hex');
}

/**
 * Verify the signature of a WeCom callback request.
 *
 * @param {string} msgSignature - msg_signature from query params
 * @param {string} token - Callback token from config
 * @param {string} timestamp - timestamp from query params
 * @param {string} nonce - nonce from query params
 * @param {string} encrypted - Encrypted message content
 * @returns {boolean}
 */
export function verifySignature(msgSignature, token, timestamp, nonce, encrypted = '') {
  const computed = computeSignature(token, timestamp, nonce, encrypted);
  // Constant-time comparison to prevent timing attacks
  if (computed.length !== msgSignature.length) return false;
  try {
    return crypto.timingSafeEqual(
      Buffer.from(computed, 'utf8'),
      Buffer.from(msgSignature, 'utf8')
    );
  } catch {
    return false;
  }
}

/**
 * Remove WeCom's custom PKCS#7 padding.
 *
 * WeCom uses PKCS#7 with a 32-byte block size (not the standard AES 16-byte
 * block size). The pad byte value can therefore be 1–32. Node's built-in
 * decipher auto-padding uses a 16-byte block and will throw "bad decrypt"
 * whenever the pad value is 17–32, and will also reject values ≤ 16 if the
 * last N bytes of the decrypted data don't all equal N (e.g. when the appended
 * corp_id bytes differ from the pad value). Manual removal is mandatory.
 *
 * @param {Buffer} buf - Raw decrypted bytes (before padding removal)
 * @returns {Buffer}
 */
function pkcs7Unpad32(buf) {
  const pad = buf[buf.length - 1];
  if (pad < 1 || pad > 32) return buf;
  return buf.subarray(0, buf.length - pad);
}

/**
 * Decrypt an encrypted WeCom message.
 *
 * WeCom's encryption scheme:
 *   plaintext = random(16B) + msg_len(4B, big-endian) + msg + corp_id
 *   padded    = PKCS#7-pad(plaintext, block_size=32)
 *   ciphertext = AES-256-CBC(padded, key=AESKey, iv=AESKey[0:16])
 *
 * IMPORTANT: Node's crypto module must have auto-padding disabled
 * (setAutoPadding(false)) because WeCom pads to a 32-byte block boundary,
 * not the standard 16-byte AES block boundary. Using the default auto-padding
 * causes "bad decrypt" for any message whose PKCS#7-32 pad byte is > 16.
 *
 * @param {string} encrypted - Base64-encoded encrypted message
 * @param {string} encodingAESKey - 43-character EncodingAESKey
 * @param {string} corpId - Expected corp_id for verification
 * @returns {{ message: string, corpId: string }}
 */
export function decrypt(encrypted, encodingAESKey, corpId) {
  const { key, iv } = deriveKeyIV(encodingAESKey);

  // Base64 decode the encrypted message
  const encryptedBuffer = Buffer.from(encrypted, 'base64');

  // AES-256-CBC decrypt.
  // setAutoPadding(false) is required: WeCom uses PKCS#7 with a 32-byte block
  // size; Node's built-in PKCS#7 validation assumes 16-byte blocks and will
  // throw "bad decrypt" whenever the pad byte value exceeds 16.
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  decipher.setAutoPadding(false);
  let raw;
  try {
    raw = Buffer.concat([decipher.update(encryptedBuffer), decipher.final()]);
  } catch (err) {
    throw new Error(`AES decryption failed: ${err.message}`);
  }

  // Strip PKCS#7 padding (block_size=32)
  const decrypted = pkcs7Unpad32(raw);

  // Parse decrypted content:
  // Bytes 0-15: random bytes (discard)
  // Bytes 16-19: message length (network byte order, big-endian uint32)
  // Bytes 20 to 20+msgLen-1: actual message (XML)
  // Remaining: corp_id
  if (decrypted.length < 20) {
    throw new Error('Decrypted data too short');
  }

  const msgLen = decrypted.readUInt32BE(16);
  if (20 + msgLen > decrypted.length) {
    throw new Error(`Message length ${msgLen} exceeds decrypted data length ${decrypted.length}`);
  }

  const message = decrypted.subarray(20, 20 + msgLen).toString('utf8');
  const extractedCorpId = decrypted.subarray(20 + msgLen).toString('utf8');

  // Verify corp_id
  if (corpId && extractedCorpId !== corpId) {
    throw new Error(`Corp ID mismatch: expected ${corpId}, got ${extractedCorpId}`);
  }

  return { message, corpId: extractedCorpId };
}

/**
 * Apply WeCom's custom PKCS#7 padding (block_size=32).
 *
 * @param {Buffer} buf
 * @returns {Buffer}
 */
function pkcs7Pad32(buf) {
  const blockSize = 32;
  const pad = blockSize - (buf.length % blockSize);
  return Buffer.concat([buf, Buffer.alloc(pad, pad)]);
}

/**
 * Encrypt a message for WeCom reply.
 *
 * Uses setAutoPadding(false) with manual PKCS#7-32 padding to match WeCom's
 * 32-byte block size requirement (same reason as decrypt).
 *
 * @param {string} replyMsg - The reply message (usually XML)
 * @param {string} encodingAESKey - 43-character EncodingAESKey
 * @param {string} corpId - Corp ID to append
 * @returns {string} Base64-encoded encrypted message
 */
export function encrypt(replyMsg, encodingAESKey, corpId) {
  const { key, iv } = deriveKeyIV(encodingAESKey);

  // Build plaintext: 16 random bytes + 4 byte msg_len + msg + corp_id
  const randomBytes = crypto.randomBytes(16);
  const msgBuffer = Buffer.from(replyMsg, 'utf8');
  const corpIdBuffer = Buffer.from(corpId, 'utf8');
  const msgLenBuffer = Buffer.alloc(4);
  msgLenBuffer.writeUInt32BE(msgBuffer.length, 0);

  const plaintext = Buffer.concat([randomBytes, msgLenBuffer, msgBuffer, corpIdBuffer]);

  // Apply WeCom's custom PKCS#7 padding (block_size=32, not standard 16)
  const padded = pkcs7Pad32(plaintext);

  // AES-256-CBC encrypt with auto-padding disabled (we handle padding manually)
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  cipher.setAutoPadding(false);
  const encrypted = Buffer.concat([cipher.update(padded), cipher.final()]);

  return encrypted.toString('base64');
}

/**
 * Build an encrypted XML reply for WeCom webhook verification or message reply.
 *
 * @param {string} encrypted - Base64-encoded encrypted content
 * @param {string} token - Verification token
 * @param {string} timestamp - Timestamp string
 * @param {string} nonce - Nonce string
 * @returns {string} XML response body
 */
export function buildEncryptedReply(encrypted, token, timestamp, nonce) {
  const signature = computeSignature(token, timestamp, nonce, encrypted);
  return `<xml>
<Encrypt><![CDATA[${encrypted}]]></Encrypt>
<MsgSignature><![CDATA[${signature}]]></MsgSignature>
<TimeStamp>${timestamp}</TimeStamp>
<Nonce><![CDATA[${nonce}]]></Nonce>
</xml>`;
}
