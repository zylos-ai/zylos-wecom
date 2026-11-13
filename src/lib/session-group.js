/**
 * Session-group mapping for zylos-core multi-session mode.
 *
 * The group name is derived only from the reply endpoint, so the inbound
 * `--session-group` value and `scripts/session-group.js <endpoint>` always
 * agree. Rules (fixed once live; changing them needs a migration with Core):
 *   private chat `<userid>|type:p2p|...`  -> dm-<userid>
 *   group chat   `<chatid>|type:group|...` -> group-<chatid>
 * Quote/reply chains stay in their chat; per-message parts (msg) never count.
 *
 * Core only accepts [A-Za-z0-9_.:-]. WeCom ids may contain '@' (userids allow
 * letters, digits and `_-@.`), so every '@' becomes ':'. WeCom ids never
 * contain ':', so the mapping stays one-to-one. Anything else throws; ids are
 * never truncated or hashed. Core adds the `wecom:` namespace.
 */

/** Core's limits for the name a component passes (Core adds `<namespace>:`). */
export const SESSION_GROUP_MAX_LENGTH = 95;
export const SESSION_GROUP_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;

/** WeCom userid / chatid as used in endpoints. */
const WECOM_ID = /^[A-Za-z0-9][A-Za-z0-9_.@-]*$/;

/**
 * Whether Core would accept this nonempty name.
 * @param {string} name
 * @returns {boolean}
 */
export function isValidSessionGroup(name) {
  return typeof name === 'string' && name.length <= SESSION_GROUP_MAX_LENGTH
    && SESSION_GROUP_PATTERN.test(name);
}

const quote = (value, max = 64) => JSON.stringify(String(value ?? '').slice(0, max));

/**
 * Derive the in-group session name from an endpoint string.
 * @param {string} endpoint - e.g. "zhangsan|type:p2p|msg:abc"
 * @returns {string} group name without namespace (never '')
 * @throws {Error} when the endpoint cannot be mapped
 */
export function sessionGroupFromEndpoint(endpoint) {
  const parts = String(endpoint ?? '').split('|');
  const id = parts[0];
  const type = parts.slice(1).find((part) => part.startsWith('type:'))?.slice('type:'.length);

  if (!WECOM_ID.test(id)) {
    throw new Error(`invalid WeCom id in endpoint: ${quote(endpoint)}`);
  }
  let prefix;
  if (type === 'p2p') prefix = 'dm';
  else if (type === 'group') prefix = 'group';
  else if (type === undefined) throw new Error(`endpoint has no type, cannot tell DM from group: ${quote(endpoint)}`);
  else throw new Error(`unknown chat type in endpoint: ${quote(type, 32)}`);

  const name = `${prefix}-${id.replace(/@/g, ':')}`;
  if (!isValidSessionGroup(name)) {
    throw new Error(`session group would be invalid for Core (length ${name.length}, max ${SESSION_GROUP_MAX_LENGTH})`);
  }
  return name;
}
