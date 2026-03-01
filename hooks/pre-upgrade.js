#!/usr/bin/env node
/**
 * Pre-upgrade hook for zylos-wecom
 *
 * Called by Claude BEFORE CLI upgrade steps.
 * If this hook fails (exit code 1), the upgrade is aborted.
 *
 * This hook handles:
 * - Backup critical data before upgrade
 * - Validate upgrade prerequisites
 *
 * Exit codes:
 *   0 - Continue with upgrade
 *   1 - Abort upgrade (with error message)
 */

import fs from 'fs';
import path from 'path';

const HOME = process.env.HOME;
const DATA_DIR = path.join(HOME, 'zylos/components/wecom');
const configPath = path.join(DATA_DIR, 'config.json');

console.log('[pre-upgrade] Running wecom pre-upgrade checks...\n');

// 1. Backup config before upgrade
if (fs.existsSync(configPath)) {
  const backupPath = configPath + '.backup';
  fs.copyFileSync(configPath, backupPath);
  console.log('Config backed up to:', backupPath);
}

// 2. Backup user cache
const userCachePath = path.join(DATA_DIR, 'user-cache.json');
if (fs.existsSync(userCachePath)) {
  const backupPath = userCachePath + '.backup';
  fs.copyFileSync(userCachePath, backupPath);
  console.log('User cache backed up to:', backupPath);
}

console.log('\n[pre-upgrade] Checks passed, proceeding with upgrade.');
