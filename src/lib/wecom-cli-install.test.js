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
  assert.match(skill, /scripts\/wecom-cli-auth\.js --check-channel-bot/);
  assert.match(skill, /--reuse-channel-bot --endpoint/);
  assert.match(skill, /No QR is generated and no new Bot/);
  assert.match(skill, /different Principal is unsupported and will be rejected/);
  assert.match(skill, /do not loop or route authorization through another channel/);
  assert.match(skill, /execute token-backed CLI office operations only for the configured owner/);
  assert.match(skill, /WECOM_CLI_ROUTE_VIOLATION/);
  assert.match(skill, /WECOM_ENDPOINT_PROVENANCE_VIOLATION/);
  assert.match(skill, /Do not run their generic\s+`npm install -g @wecom\/cli`/);
  assert.match(skill, /install\/upgrade hook exclusively owns the pinned CLI binary/);
});

test('root documentation exposes only the managed same-Bot office auth flow', () => {
  const documents = [
    'README.md',
    'README.zh-CN.md',
    'DESIGN.md',
    'CHANGELOG.md',
    'SKILL.md',
    path.join('references', 'UPSTREAM.md'),
    path.join('docs', 'capability-trim-rubric.md')
  ].map((relativePath) => [
    relativePath,
    fs.readFileSync(path.join(root, relativePath), 'utf8')
  ]);

  for (const [relativePath, content] of documents) {
    assert.match(content, /same-Bot|同 Bot|exact channel Bot|exact channel-Bot/,
      `${relativePath} must describe the same-Bot boundary`);
  }

  const readme = documents.find(([name]) => name === 'README.md')[1];
  const readmeZh = documents.find(([name]) => name === 'README.zh-CN.md')[1];
  assert.match(readme, /--check-channel-bot/);
  assert.match(readme, /--reuse-channel-bot/);
  assert.match(readme, /No QR is generated and no additional Bot is\s+created/);
  assert.match(readmeZh, /--check-channel-bot/);
  assert.match(readmeZh, /--reuse-channel-bot/);
  assert.match(readmeZh, /不扫码、不创建/);

  for (const [relativePath, content] of documents) {
    assert.doesNotMatch(content, /wecom-cli auth init\s*\n```/,
      `${relativePath} must not present raw auth init as an executable workflow`);
    assert.doesNotMatch(content, /QR (?:command|image).*fallback|二维码.*(?:正常入口|回退)/i,
      `${relativePath} must not claim independent-Bot QR fallback is supported`);
  }
});

test('channel sender stays on the internal WebSocket path, not the office CLI', () => {
  const sender = fs.readFileSync(path.join(root, 'scripts', 'send.js'), 'utf8');

  assert.match(sender, /\/internal\/send/);
  assert.doesNotMatch(sender, /runWecomCli|wecom-cli/);
});

test('server records the exact owner DM reply endpoint before durable C4 delivery', () => {
  const server = fs.readFileSync(path.join(root, 'src', 'index.js'), 'utf8');

  assert.match(
    server,
    /endpoint = `\$\{fromUser\}\|type:p2p\|msg:\$\{msgId\}`;[\s\S]*?recordOwnerReplyEndpoint\(endpoint, config\);[\s\S]*?messageDeliveryOutbox\.enqueue\(\{[\s\S]*?endpoint,[\s\S]*?\}\);[\s\S]*?scheduleOutboxDelivery\(queued\.record\);/
  );
  assert.match(server, /forward: \(entry\) => forwardToC4\(entry\.content, entry\.endpoint\)/);
});

test('upstream snapshots document the component lifecycle override', () => {
  const upstream = fs.readFileSync(path.join(root, 'references', 'UPSTREAM.md'), 'utf8');

  assert.match(upstream, /Generic upstream instructions to run\s+`npm install -g @wecom\/cli`/);
  assert.match(upstream, /managed same-Bot\s+owner-DM helper owns authorization without QR/);
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
