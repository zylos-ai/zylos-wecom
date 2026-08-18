import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  EXPECTED_CLI_SKILLS,
  getInstalledWecomCliVersion,
  getTargetWecomCliVersion,
  installWecomCliBinary,
  semverCompare,
  verifyBundledWecomSkills
} from '../../hooks/wecom-cli-shared.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('package pins the supported official CLI version', () => {
  assert.match(getTargetWecomCliVersion(), /^\d+\.\d+\.\d+$/);
  assert.equal(getTargetWecomCliVersion(), '1.1.0');
});

test('package and lockfile require the patched ws release', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(
    fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8')
  );

  assert.equal(pkg.dependencies.ws, '^8.21.3');
  assert.equal(lock.packages[''].dependencies.ws, '^8.21.3');
  assert.equal(lock.packages['node_modules/ws'].version, '8.21.3');
});

test('root skill keeps CLI authorization in the originating WeCom owner DM', () => {
  const skill = fs.readFileSync(path.join(root, 'SKILL.md'), 'utf8');

  assert.match(skill, /private WeCom DM sent by the\s+configured owner/);
  assert.match(skill, /scripts\/wecom-cli-auth\.js --endpoint/);
  assert.match(skill, /returns the temporary official link and\s+PNG through that exact WeCom endpoint/);
  assert.match(skill, /do not loop or route authorization through another channel/);
  assert.match(skill, /execute token-backed CLI office operations only for the configured owner/);
});

test('semverCompare handles older, equal, and newer versions', () => {
  assert.equal(semverCompare('1.0.9', '1.1.0'), -1);
  assert.equal(semverCompare('1.1.0', '1.1.0'), 0);
  assert.equal(semverCompare('1.2.0', '1.1.0'), 1);
});

test('getInstalledWecomCliVersion parses official version output', () => {
  const version = getInstalledWecomCliVersion(() =>
    'wecom-cli 1.1.0 (npm 2026-08-17T00:00:00Z abc123)'
  );
  assert.equal(version, '1.1.0');
});

test('installWecomCliBinary skips an equal or newer installation', () => {
  const calls = [];
  const result = installWecomCliBinary((command, args) => {
    calls.push([command, args]);
    return 'wecom-cli 1.2.0 (npm now commit)';
  });
  assert.deepEqual(result, { installed: false, version: '1.2.0' });
  assert.equal(calls.length, 1);
});

test('installWecomCliBinary installs with argv and verifies the result', () => {
  const calls = [];
  let probes = 0;
  const result = installWecomCliBinary((command, args) => {
    calls.push([command, args]);
    if (command === 'wecom-cli') {
      probes += 1;
      if (probes === 1) throw new Error('missing');
      return 'wecom-cli 1.1.0 (npm now commit)';
    }
    return '';
  });

  assert.deepEqual(result, { installed: true, version: '1.1.0' });
  assert.deepEqual(calls[1], ['npm', ['install', '-g', '@wecom/cli@1.1.0']]);
});

test('all modular CLI skills and the Unified router are bundled', () => {
  assert.equal(EXPECTED_CLI_SKILLS.length, 14);
  assert.deepEqual(verifyBundledWecomSkills(root), {
    cliSkills: 14,
    unified: true
  });
  assert.ok(
    fs.existsSync(path.join(root, 'references', 'wecom-unified', 'references'))
  );
  assert.ok(fs.existsSync(path.join(root, 'scripts', 'wecom-cli-auth.js')));
  assert.ok(fs.existsSync(path.join(root, 'src', 'lib', 'wecom-cli-auth.js')));
});

test('bundled skill markdown has no broken relative file links', () => {
  const roots = [
    path.join(root, 'references', 'wecom-cli'),
    path.join(root, 'references', 'wecom-unified')
  ];
  const markdownFiles = [];

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(filePath);
      else if (entry.name.endsWith('.md')) markdownFiles.push(filePath);
    }
  }
  roots.forEach(walk);

  const broken = [];
  const linkPattern = /\[[^\]]*\]\(([^)]+)\)/g;
  for (const markdownFile of markdownFiles) {
    const content = fs.readFileSync(markdownFile, 'utf8');
    for (const match of content.matchAll(linkPattern)) {
      const rawTarget = match[1].trim().replace(/^<|>$/g, '');
      if (!rawTarget || /^(?:https?:|mailto:|#)/i.test(rawTarget)) continue;
      const target = decodeURIComponent(rawTarget.split('#')[0].split('?')[0]);
      if (!target || target.includes('<') || !/\.(?:md|py)$/i.test(target)) continue;
      const resolved = path.resolve(path.dirname(markdownFile), target);
      if (!fs.existsSync(resolved)) {
        broken.push(`${path.relative(root, markdownFile)} -> ${rawTarget}`);
      }
    }
  }

  assert.deepEqual(broken, []);
});
