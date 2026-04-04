import fs from 'fs';
import os from 'os';
import path from 'path';
import test from 'node:test';
import assert from 'node:assert/strict';

async function importFreshConfigModule(homeDir) {
  process.env.HOME = homeDir;
  return import(`./config.js?home=${encodeURIComponent(homeDir)}&ts=${Date.now()}`);
}

test('getCredentials reads environment variables unchanged', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-wecom-config-env-'));
  process.env.WECOM_BOT_ID = 'env-bot';
  process.env.WECOM_BOT_SECRET = 'env-secret';

  const config = await importFreshConfigModule(homeDir);
  assert.deepEqual(config.getCredentials(), {
    bot_id: 'env-bot',
    secret: 'env-secret'
  });
});

test('saveCredentialsToEnv upserts the existing env credential keys', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-wecom-config-file-'));
  const envDir = path.join(homeDir, 'zylos');
  fs.mkdirSync(envDir, { recursive: true });
  fs.writeFileSync(path.join(envDir, '.env'), 'FOO=bar\nWECOM_BOT_ID=old-id\n', 'utf8');

  const config = await importFreshConfigModule(homeDir);
  const envPath = config.saveCredentialsToEnv({
    bot_id: 'new-bot',
    secret: 'new-secret'
  });

  assert.equal(envPath, path.join(homeDir, 'zylos/.env'));
  assert.equal(
    fs.readFileSync(envPath, 'utf8'),
    'FOO=bar\nWECOM_BOT_ID=new-bot\nWECOM_BOT_SECRET=new-secret\n'
  );

  const stat = fs.statSync(envPath);
  assert.equal(stat.mode & 0o777, 0o600);
});
