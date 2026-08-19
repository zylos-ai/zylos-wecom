#!/usr/bin/env node

import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(process.env.HOME || '', 'zylos/.env') });

const { getConfig } = await import('../src/lib/config.js');
const {
  authorizeWecomCli,
  checkWecomCliAuthMatchesBot,
  runOfficialWecomCliManualAuth
} = await import('../src/lib/wecom-cli-auth.js');

function readEndpoint(args) {
  const index = args.indexOf('--endpoint');
  return index >= 0 ? args[index + 1] : '';
}

try {
  const args = process.argv.slice(2);
  if (args.includes('--check-channel-bot')) {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      status: checkWecomCliAuthMatchesBot(process.env.WECOM_BOT_ID)
        ? 'same_bot_authorized'
        : 'reauthorization_required'
    })}\n`);
    process.exit(0);
  }
  const reuseChannelBot = args.includes('--reuse-channel-bot');
  const authOptions = reuseChannelBot ? {
    runAuth: () => runOfficialWecomCliManualAuth({
      botId: process.env.WECOM_BOT_ID,
      secret: process.env.WECOM_BOT_SECRET
    }),
    checkStatus: () => checkWecomCliAuthMatchesBot(process.env.WECOM_BOT_ID)
  } : {};
  const result = await authorizeWecomCli({
    endpoint: readEndpoint(args),
    config: getConfig(),
    ...authOptions
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
