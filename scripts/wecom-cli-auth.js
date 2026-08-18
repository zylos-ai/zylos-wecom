#!/usr/bin/env node

import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(process.env.HOME || '', 'zylos/.env') });

const { getConfig } = await import('../src/lib/config.js');
const { authorizeWecomCli } = await import('../src/lib/wecom-cli-auth.js');

function readEndpoint(args) {
  const index = args.indexOf('--endpoint');
  return index >= 0 ? args[index + 1] : '';
}

try {
  const result = await authorizeWecomCli({
    endpoint: readEndpoint(process.argv.slice(2)),
    config: getConfig()
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    ok: false,
    error: error.code || 'auth_flow_failed',
    message: error.message
  })}\n`);
  process.exitCode = 1;
}
