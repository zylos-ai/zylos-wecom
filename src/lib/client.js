/**
 * WeCom API Client
 *
 * Handles access_token management and provides HTTP helpers for all WeCom API calls.
 * No SDK dependency -- uses direct HTTP calls via axios.
 *
 * Credentials from environment variables:
 * - WECOM_CORP_ID
 * - WECOM_CORP_SECRET
 */

import axios from 'axios';
import { getCredentials, getProxyConfig } from './config.js';

const WECOM_API_BASE = 'https://qyapi.weixin.qq.com/cgi-bin';

// Token cache
let cachedToken = null;
let tokenExpiresAt = 0;

// Refresh 5 minutes before actual expiry
const TOKEN_REFRESH_MARGIN = 5 * 60 * 1000;

/**
 * Get a valid access_token, refreshing if needed.
 * Caches the token in memory with expiry tracking.
 *
 * @returns {Promise<string>} Valid access_token
 */
export async function getAccessToken() {
  const now = Date.now();

  if (cachedToken && now < tokenExpiresAt - TOKEN_REFRESH_MARGIN) {
    return cachedToken;
  }

  const creds = getCredentials();
  if (!creds.corp_id || !creds.corp_secret) {
    throw new Error('WECOM_CORP_ID and WECOM_CORP_SECRET must be set in ~/zylos/.env');
  }

  const proxy = getProxyConfig();

  try {
    const res = await axios({
      method: 'GET',
      url: `${WECOM_API_BASE}/gettoken`,
      params: {
        corpid: creds.corp_id,
        corpsecret: creds.corp_secret
      },
      timeout: 15000,
      proxy
    });

    if (res.data.errcode !== 0) {
      throw new Error(`WeCom token error (${res.data.errcode}): ${res.data.errmsg}`);
    }

    cachedToken = res.data.access_token;
    // expires_in is in seconds; convert to ms and subtract margin
    tokenExpiresAt = now + (res.data.expires_in * 1000);

    return cachedToken;
  } catch (err) {
    // Clear cached token on error so next call retries
    cachedToken = null;
    tokenExpiresAt = 0;
    throw new Error(`Failed to get access_token: ${err.message}`);
  }
}

/**
 * Reset the cached access token (useful when receiving invalid token errors).
 */
export function resetToken() {
  cachedToken = null;
  tokenExpiresAt = 0;
}

/**
 * Make an authenticated API request to WeCom.
 *
 * @param {string} method - HTTP method ('GET' or 'POST')
 * @param {string} apiPath - API path (e.g., '/message/send')
 * @param {object} [data] - Request body (for POST) or query params (for GET, merged with token)
 * @param {object} [options] - Additional axios options (headers, responseType, etc.)
 * @returns {Promise<object>} Response data
 */
export async function apiRequest(method, apiPath, data = null, options = {}) {
  const token = await getAccessToken();
  const proxy = getProxyConfig();
  const url = `${WECOM_API_BASE}${apiPath}`;

  const axiosConfig = {
    method,
    url,
    params: { access_token: token },
    timeout: options.timeout || 30000,
    proxy,
    ...options
  };

  if (method.toUpperCase() === 'POST' && data) {
    axiosConfig.data = data;
    if (!axiosConfig.headers) {
      axiosConfig.headers = { 'Content-Type': 'application/json' };
    }
  } else if (method.toUpperCase() === 'GET' && data) {
    axiosConfig.params = { ...axiosConfig.params, ...data };
  }

  try {
    const res = await axios(axiosConfig);
    const result = res.data;

    // Handle invalid token (42001) - retry once with fresh token
    if (result.errcode === 42001 || result.errcode === 40014) {
      resetToken();
      const freshToken = await getAccessToken();
      axiosConfig.params.access_token = freshToken;
      const retryRes = await axios(axiosConfig);
      return retryRes.data;
    }

    return result;
  } catch (err) {
    throw new Error(`WeCom API request failed (${apiPath}): ${err.message}`);
  }
}

/**
 * Get user details from WeCom.
 *
 * @param {string} userId - WeCom user ID
 * @returns {Promise<{success: boolean, user?: object, message?: string}>}
 */
export async function getUserInfo(userId) {
  try {
    const result = await apiRequest('GET', '/user/get', { userid: userId });

    if (result.errcode === 0) {
      return {
        success: true,
        user: {
          userId: result.userid,
          name: result.name,
          email: result.email,
          mobile: result.mobile,
          avatar: result.avatar,
          department: result.department,
          position: result.position
        }
      };
    } else {
      return {
        success: false,
        message: `Failed to get user info (${result.errcode}): ${result.errmsg}`
      };
    }
  } catch (err) {
    return { success: false, message: err.message };
  }
}

/**
 * Test authentication by fetching agent info.
 *
 * @returns {Promise<{success: boolean, message: string}>}
 */
export async function testAuth() {
  try {
    const token = await getAccessToken();
    return { success: true, message: `Authentication successful (token: ${token.slice(0, 8)}...)` };
  } catch (err) {
    return { success: false, message: err.message };
  }
}
