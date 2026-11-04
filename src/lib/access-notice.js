/**
 * Access-control user notices.
 *
 * - Group access evaluation that distinguishes "group not enabled" from
 *   "sender not allowed in an enabled group", so a blocked @-mention can be
 *   answered with the right notice instead of being dropped silently.
 * - One-time owner guide sent right after the first DM binds the owner.
 *
 * User-facing texts are intentionally Chinese-only (owner decision for
 * OPENM-1149); they are not switched by runtime locale.
 */

export const GROUP_BLOCK_REASON = Object.freeze({
  NOT_ENABLED: 'group_not_enabled',
  SENDER_NOT_ALLOWED: 'sender_not_allowed'
});

export const GROUP_NOT_ENABLED_NOTICE = '本群还没开通，请联系 Agent 管理者开启';
export const GROUP_NO_PERMISSION_NOTICE = '你在本群暂无权限使用我，请联系 Agent 管理者开通';
export const OWNER_GUIDE_TEXT = [
  '你已成为这个 Agent 的管理者。',
  '开启群聊：把我拉进群后，在群里 @我 说「开启本群」。',
  '开放私聊：跟我说「允许所有同事私聊你」，或「允许某某私聊你」。'
].join('\n');

export function isOwner(config, userId) {
  if (!config?.owner?.bound) return false;
  return String(userId) === String(config.owner.user_id);
}

/**
 * Evaluate whether a group message is allowed.
 * Returns { allowed: true } or { allowed: false, reason }.
 *
 * No mention check: WeCom only delivers group callbacks when the bot is
 * @-mentioned (developer.work.weixin.qq.com/document/path/100719), so a group
 * callback arriving at all implies the bot was mentioned.
 */
export function evaluateGroupAccess(config, chatId, userId) {
  if (isOwner(config, userId)) return { allowed: true };
  const policy = config?.groupPolicy || 'allowlist';
  switch (policy) {
    case 'open':
      return { allowed: true };
    case 'allowlist': {
      const groupConfig = config?.groups?.[chatId];
      if (!groupConfig) {
        return { allowed: false, reason: GROUP_BLOCK_REASON.NOT_ENABLED };
      }
      const allowFrom = groupConfig.allowFrom;
      if (Array.isArray(allowFrom) && allowFrom.length > 0) {
        if (allowFrom.includes('*')) return { allowed: true };
        if (allowFrom.some(id => String(id) === String(userId))) return { allowed: true };
        return { allowed: false, reason: GROUP_BLOCK_REASON.SENDER_NOT_ALLOWED };
      }
      return { allowed: true };
    }
    case 'disabled':
    default:
      return { allowed: false, reason: GROUP_BLOCK_REASON.NOT_ENABLED };
  }
}

export function renderGroupBlockedNotice(reason) {
  return reason === GROUP_BLOCK_REASON.SENDER_NOT_ALLOWED
    ? GROUP_NO_PERMISSION_NOTICE
    : GROUP_NOT_ENABLED_NOTICE;
}

/**
 * Bind the first DM sender as owner if no owner is bound yet.
 * Returns true only on the bind event itself (and only if it was persisted).
 */
export function bindOwnerIfUnbound(config, userId, userName, save) {
  if (config.owner?.bound) return false;

  config.owner = {
    bound: true,
    user_id: String(userId),
    name: userName || String(userId)
  };

  return Boolean(save(config));
}

/**
 * Send a notice without ever throwing or blocking the caller on the result.
 * Failures (rejected promise or { ok: false }) are logged and swallowed.
 * Returns the in-flight promise so callers/tests may await it if desired.
 */
export function sendNoticeSafely(send, label, onError = (msg) => console.error(msg)) {
  let pending;
  try {
    pending = Promise.resolve(send());
  } catch (err) {
    pending = Promise.reject(err);
  }
  return pending
    .then((result) => {
      if (result && result.ok === false) {
        onError(`[wecom] Failed to send ${label}: ${result.error || 'unknown error'}`);
        return false;
      }
      return true;
    })
    .catch((err) => {
      onError(`[wecom] Failed to send ${label}: ${err?.message || err}`);
      return false;
    });
}
