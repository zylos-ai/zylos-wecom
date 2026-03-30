#!/usr/bin/env node

import { spawnSync } from 'child_process';
import { getConfig } from '../src/lib/config.js';
import { t } from '../src/lib/i18n/cli-messages.js';
import { parseLocaleArg, resolveLocale } from '../src/lib/i18n/locale.js';
import { getDocConfigPaths, refreshDocConfigFromRuntime, resolveDocConfig } from './wecom-doc-config.js';

const runtimeConfig = getConfig();
const locale = resolveLocale({
  cliLocale: parseLocaleArg(process.argv.slice(2)),
  configLocale: runtimeConfig?.message?.locale,
  envLocale: process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG
});

function runMcporter(args) {
  return spawnSync('mcporter', args, { stdio: 'pipe', encoding: 'utf8' });
}

function getExistingMcporterServer(name) {
  const result = runMcporter(['config', 'get', name, '--json']);
  if (result.status !== 0) return null;
  try {
    return JSON.parse(result.stdout || '{}');
  } catch {
    return null;
  }
}

function resolveServerUrl(server) {
  return typeof server?.baseUrl === 'string' ? server.baseUrl : '';
}

function resolveServerTransport(server) {
  return typeof server?.transport === 'string' ? server.transport : '';
}

const { primary, fallback } = getDocConfigPaths();
const docConfig = await refreshDocConfigFromRuntime(runtimeConfig) || resolveDocConfig();
if (!docConfig) {
  console.error(t(locale, 'setup_no_config'));
  console.error(t(locale, 'setup_checked', { path: primary }));
  console.error(t(locale, 'setup_checked', { path: fallback }));
  process.exit(1);
}

const probe = runMcporter(['list', 'wecom-doc', '--output', 'json']);
if (probe.status === 0) {
  const existing = getExistingMcporterServer('wecom-doc');
  const currentUrl = resolveServerUrl(existing);
  const currentTransport = resolveServerTransport(existing);
  const needsUpdate = currentUrl !== docConfig.url || currentTransport !== 'http';

  if (!needsUpdate) {
    console.log(t(locale, 'setup_already_configured'));
    if (docConfig.isAuthed === false) {
      console.log(t(locale, 'setup_auth_incomplete_warning'));
      if (docConfig.authPageUrl) {
        console.log(t(locale, 'setup_auth_page', { url: docConfig.authPageUrl }));
      } else if (docConfig.botId) {
        console.log(t(locale, 'setup_bot_id', { botId: docConfig.botId }));
      }
    }
    process.stdout.write(probe.stdout || '');
    process.exit(0);
  }

  const update = runMcporter(['config', 'add', 'wecom-doc', '--url', docConfig.url]);
  if (update.status !== 0) {
    process.stderr.write(update.stderr || '');
    process.exit(update.status || 1);
  }

  console.log(t(locale, 'setup_configured_from', { source: docConfig.source }));
  if (docConfig.isAuthed === false) {
    console.log(t(locale, 'setup_auth_incomplete_warning'));
    if (docConfig.authPageUrl) {
      console.log(t(locale, 'setup_auth_page', { url: docConfig.authPageUrl }));
    } else if (docConfig.botId) {
      console.log(t(locale, 'setup_bot_id', { botId: docConfig.botId }));
    }
  }
  const verifyExisting = runMcporter(['list', 'wecom-doc', '--output', 'json']);
  if (verifyExisting.stdout) process.stdout.write(verifyExisting.stdout);
  if (verifyExisting.status !== 0) {
    process.stderr.write(verifyExisting.stderr || '');
    process.exit(verifyExisting.status || 1);
  }
  process.exit(0);
}

if (probe.error && probe.error.code === 'ENOENT') {
  console.error(t(locale, 'setup_mcporter_missing'));
  process.exit(1);
}

const add = runMcporter(['config', 'add', 'wecom-doc', '--url', docConfig.url]);
if (add.status !== 0) {
  process.stderr.write(add.stderr || '');
  process.exit(add.status || 1);
}

console.log(t(locale, 'setup_configured_from', { source: docConfig.source }));
if (docConfig.isAuthed === false) {
  console.log(t(locale, 'setup_auth_required_warning'));
  if (docConfig.authPageUrl) {
    console.log(t(locale, 'setup_auth_page', { url: docConfig.authPageUrl }));
  } else if (docConfig.botId) {
    console.log(t(locale, 'setup_bot_id', { botId: docConfig.botId }));
  }
}
const verify = runMcporter(['list', 'wecom-doc', '--output', 'json']);
if (verify.stdout) process.stdout.write(verify.stdout);
if (verify.status !== 0) {
  process.stderr.write(verify.stderr || '');
  process.exit(verify.status || 1);
}
