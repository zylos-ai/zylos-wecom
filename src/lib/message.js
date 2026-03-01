/**
 * WeCom Messaging Functions
 *
 * Send text, markdown, image, file messages.
 * Upload and download media files.
 */

import fs from 'fs';
import path from 'path';
import axios from 'axios';
import FormData from 'form-data';
import { getAccessToken, apiRequest, resetToken } from './client.js';
import { getCredentials, getProxyConfig, DATA_DIR } from './config.js';

const WECOM_API_BASE = 'https://qyapi.weixin.qq.com/cgi-bin';
const MEDIA_DIR = path.join(DATA_DIR, 'media');

/**
 * Send a text message to a WeCom user.
 *
 * @param {string} toUser - Target user ID (use "@all" for broadcast)
 * @param {string} content - Text content
 * @returns {Promise<{success: boolean, message?: string}>}
 */
export async function sendTextMessage(toUser, content) {
  const creds = getCredentials();
  const agentId = creds.agent_id;

  try {
    const result = await apiRequest('POST', '/message/send', {
      touser: String(toUser),
      msgtype: 'text',
      agentid: agentId,
      text: {
        content: String(content)
      }
    });

    if (result.errcode === 0) {
      return { success: true, message: 'Text message sent successfully' };
    } else {
      return {
        success: false,
        message: `Failed to send text (${result.errcode}): ${result.errmsg}`,
        errcode: result.errcode
      };
    }
  } catch (err) {
    return { success: false, message: err.message };
  }
}

/**
 * Send a markdown message to a WeCom user.
 * Note: Markdown messages are only visible in WeCom app (not WeChat).
 *
 * @param {string} toUser - Target user ID
 * @param {string} content - Markdown content
 * @returns {Promise<{success: boolean, message?: string}>}
 */
export async function sendMarkdownMessage(toUser, content) {
  const creds = getCredentials();
  const agentId = creds.agent_id;

  try {
    const result = await apiRequest('POST', '/message/send', {
      touser: String(toUser),
      msgtype: 'markdown',
      agentid: agentId,
      markdown: {
        content: String(content)
      }
    });

    if (result.errcode === 0) {
      return { success: true, message: 'Markdown message sent successfully' };
    } else {
      return {
        success: false,
        message: `Failed to send markdown (${result.errcode}): ${result.errmsg}`,
        errcode: result.errcode
      };
    }
  } catch (err) {
    return { success: false, message: err.message };
  }
}

/**
 * Send an image message using a media_id.
 *
 * @param {string} toUser - Target user ID
 * @param {string} mediaId - Media ID from uploadMedia()
 * @returns {Promise<{success: boolean, message?: string}>}
 */
export async function sendImageMessage(toUser, mediaId) {
  const creds = getCredentials();
  const agentId = creds.agent_id;

  try {
    const result = await apiRequest('POST', '/message/send', {
      touser: String(toUser),
      msgtype: 'image',
      agentid: agentId,
      image: {
        media_id: String(mediaId)
      }
    });

    if (result.errcode === 0) {
      return { success: true, message: 'Image message sent successfully' };
    } else {
      return {
        success: false,
        message: `Failed to send image (${result.errcode}): ${result.errmsg}`,
        errcode: result.errcode
      };
    }
  } catch (err) {
    return { success: false, message: err.message };
  }
}

/**
 * Send a file message using a media_id.
 *
 * @param {string} toUser - Target user ID
 * @param {string} mediaId - Media ID from uploadMedia()
 * @returns {Promise<{success: boolean, message?: string}>}
 */
export async function sendFileMessage(toUser, mediaId) {
  const creds = getCredentials();
  const agentId = creds.agent_id;

  try {
    const result = await apiRequest('POST', '/message/send', {
      touser: String(toUser),
      msgtype: 'file',
      agentid: agentId,
      file: {
        media_id: String(mediaId)
      }
    });

    if (result.errcode === 0) {
      return { success: true, message: 'File message sent successfully' };
    } else {
      return {
        success: false,
        message: `Failed to send file (${result.errcode}): ${result.errmsg}`,
        errcode: result.errcode
      };
    }
  } catch (err) {
    return { success: false, message: err.message };
  }
}

/**
 * Upload media to WeCom temporary media storage.
 * Media expires after 3 days.
 *
 * @param {string} filePath - Absolute path to the file
 * @param {string} type - Media type: 'image', 'voice', 'video', 'file'
 * @returns {Promise<{success: boolean, mediaId?: string, message?: string}>}
 */
export async function uploadMedia(filePath, type = 'file') {
  const validTypes = ['image', 'voice', 'video', 'file'];
  if (!validTypes.includes(type)) {
    return { success: false, message: `Invalid media type: ${type}. Must be one of: ${validTypes.join(', ')}` };
  }

  if (!fs.existsSync(filePath)) {
    return { success: false, message: `File not found: ${filePath}` };
  }

  try {
    const token = await getAccessToken();
    const proxy = getProxyConfig();

    const form = new FormData();
    form.append('media', fs.createReadStream(filePath));

    const res = await axios({
      method: 'POST',
      url: `${WECOM_API_BASE}/media/upload`,
      params: {
        access_token: token,
        type
      },
      headers: form.getHeaders(),
      data: form,
      timeout: 60000,
      proxy
    });

    if (res.data.errcode === 0 || res.data.media_id) {
      return {
        success: true,
        mediaId: res.data.media_id,
        message: 'Media uploaded successfully'
      };
    } else {
      // Retry once on token error
      if (res.data.errcode === 42001 || res.data.errcode === 40014) {
        resetToken();
        const freshToken = await getAccessToken();
        const form2 = new FormData();
        form2.append('media', fs.createReadStream(filePath));
        const retryRes = await axios({
          method: 'POST',
          url: `${WECOM_API_BASE}/media/upload`,
          params: { access_token: freshToken, type },
          headers: form2.getHeaders(),
          data: form2,
          timeout: 60000,
          proxy
        });
        if (retryRes.data.errcode === 0 || retryRes.data.media_id) {
          return { success: true, mediaId: retryRes.data.media_id, message: 'Media uploaded (retry)' };
        }
        return {
          success: false,
          message: `Upload failed after retry (${retryRes.data.errcode}): ${retryRes.data.errmsg}`
        };
      }
      return {
        success: false,
        message: `Failed to upload media (${res.data.errcode}): ${res.data.errmsg}`
      };
    }
  } catch (err) {
    return { success: false, message: `Upload error: ${err.message}` };
  }
}

/**
 * Download media from WeCom by media_id.
 * Saves to the media directory with path traversal prevention.
 *
 * @param {string} mediaId - Media ID to download
 * @param {string} [savePath] - Optional save path. If not provided, saves to media/ dir.
 * @returns {Promise<{success: boolean, path?: string, message?: string}>}
 */
export async function downloadMedia(mediaId, savePath = null) {
  try {
    const token = await getAccessToken();
    const proxy = getProxyConfig();

    const res = await axios({
      method: 'GET',
      url: `${WECOM_API_BASE}/media/get`,
      params: {
        access_token: token,
        media_id: mediaId
      },
      responseType: 'arraybuffer',
      timeout: 60000,
      proxy
    });

    if (!res.data || res.data.length === 0) {
      return { success: false, message: 'No data in response' };
    }

    // Check if response is an error JSON
    try {
      const text = res.data.toString('utf8');
      const parsed = JSON.parse(text);
      if (parsed.errcode) {
        return {
          success: false,
          message: `Download failed (${parsed.errcode}): ${parsed.errmsg}`
        };
      }
    } catch {
      // Not JSON, it's actual media data -- continue
    }

    // Determine file path
    let outputPath;
    if (savePath) {
      // Path traversal prevention
      const resolvedPath = path.resolve(savePath);
      const allowedDirs = [path.resolve(MEDIA_DIR), path.resolve('/tmp')];
      if (!allowedDirs.some(dir => resolvedPath.startsWith(dir + path.sep) || resolvedPath === dir)) {
        return { success: false, message: 'Save path not in allowed directory' };
      }
      outputPath = resolvedPath;
    } else {
      // Extract filename from Content-Disposition header or use media_id
      let filename = String(mediaId).replace(/[^a-zA-Z0-9_.-]/g, '_');
      const disposition = res.headers['content-disposition'];
      if (disposition) {
        const filenameMatch = disposition.match(/filename="?([^";\n]+)"?/);
        if (filenameMatch) {
          filename = filenameMatch[1].replace(/[^a-zA-Z0-9_.-]/g, '_');
        }
      }
      fs.mkdirSync(MEDIA_DIR, { recursive: true });
      outputPath = path.join(MEDIA_DIR, filename);
    }

    fs.writeFileSync(outputPath, res.data);
    return { success: true, path: outputPath, message: 'Media downloaded successfully' };
  } catch (err) {
    return { success: false, message: `Download error: ${err.message}` };
  }
}
