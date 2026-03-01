/**
 * WeCom Contact/User Functions
 *
 * User info lookup via WeCom REST API.
 */

import { apiRequest } from './client.js';

/**
 * Get user info by user_id.
 *
 * @param {string} userId - WeCom user ID
 * @returns {Promise<{success: boolean, user?: object, message?: string}>}
 */
export async function getUserInfo(userId) {
  try {
    const result = await apiRequest('GET', '/user/get', { userid: String(userId) });

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
 * Get department user list.
 *
 * @param {number} departmentId - Department ID (1 = root)
 * @returns {Promise<{success: boolean, users?: Array, message?: string}>}
 */
export async function getDepartmentUsers(departmentId = 1) {
  try {
    const result = await apiRequest('GET', '/user/simplelist', {
      department_id: departmentId
    });

    if (result.errcode === 0) {
      return {
        success: true,
        users: (result.userlist || []).map(u => ({
          userId: u.userid,
          name: u.name,
          department: u.department
        }))
      };
    } else {
      return {
        success: false,
        message: `Failed to list users (${result.errcode}): ${result.errmsg}`
      };
    }
  } catch (err) {
    return { success: false, message: err.message };
  }
}
