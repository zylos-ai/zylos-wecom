import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

import { verifyWecomVendorIntegrity } from '../src/lib/wecom-vendor-integrity.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FALLBACK_VERSION = '1.1.0';
const WECOM_CLI_PACKAGE = '@wecom/cli';
const LOG_PREFIX = '[zylos-wecom]';

export const EXPECTED_CLI_SKILLS = Object.freeze([
  'wecomcli-calendar',
  'wecomcli-contact',
  'wecomcli-disk',
  'wecomcli-doc',
  'wecomcli-doc-manage',
  'wecomcli-email',
  'wecomcli-media',
  'wecomcli-meeting',
  'wecomcli-message',
  'wecomcli-shared',
  'wecomcli-sheet',
  'wecomcli-smartpage',
  'wecomcli-smartsheet',
  'wecomcli-todo'
]);

export function getTargetWecomCliVersion() {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8')
    );
    return pkg.wecomCli?.version || FALLBACK_VERSION;
  } catch {
    return FALLBACK_VERSION;
  }
}

export function semverCompare(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
  }
  return 0;
}

export function getInstalledWecomCliVersion(exec = execFileSync) {
  try {
    const output = exec('wecom-cli', ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    return output.match(/(\d+\.\d+\.\d+)/)?.[1] || null;
  } catch {
    return null;
  }
}

export function installWecomCliBinary(exec = execFileSync) {
  const target = getTargetWecomCliVersion();
  const installed = getInstalledWecomCliVersion(exec);

  if (installed && semverCompare(installed, target) >= 0) {
    console.log(`${LOG_PREFIX} wecom-cli ${installed} >= target ${target}, skipping`);
    return { installed: false, version: installed };
  }

  const reason = installed ? `upgrading ${installed}` : 'installing';
  console.log(`${LOG_PREFIX} ${reason} wecom-cli ${target}`);
  exec('npm', ['install', '-g', `${WECOM_CLI_PACKAGE}@${target}`], {
    stdio: 'inherit'
  });

  const current = getInstalledWecomCliVersion(exec);
  if (!current || semverCompare(current, target) < 0) {
    throw new Error(`wecom-cli ${target} was not available after npm install`);
  }

  return { installed: true, version: current };
}

export function verifyBundledWecomSkills(skillDir) {
  if (!skillDir) throw new Error('verifyBundledWecomSkills: skillDir is required');

  const cliRoot = path.join(skillDir, 'references', 'wecom-cli');
  const missing = EXPECTED_CLI_SKILLS.filter(
    (name) => !fs.existsSync(path.join(cliRoot, name, 'SKILL.md'))
  );
  const unified = path.join(skillDir, 'references', 'wecom-unified', 'SKILL.md');
  if (!fs.existsSync(unified)) missing.push('wecom-unified');
  const integrationFiles = [
    'scripts/wecom-cli-auth.js',
    'src/lib/wecom-cli-auth.js'
  ];
  for (const file of integrationFiles) {
    if (!fs.existsSync(path.join(skillDir, file))) missing.push(file);
  }

  if (missing.length > 0) {
    throw new Error(`bundled WeCom skills are incomplete: ${missing.join(', ')}`);
  }

  const integrity = verifyWecomVendorIntegrity(skillDir);

  console.log(
    `${LOG_PREFIX} verified ${EXPECTED_CLI_SKILLS.length} CLI skills, Unified router, auth helper, and ${integrity.snapshots.length} pinned snapshots`
  );
  return { cliSkills: EXPECTED_CLI_SKILLS.length, unified: true };
}
