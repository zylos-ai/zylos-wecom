import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  inspectWecomVendorIntegrity,
  verifyWecomVendorIntegrity
} from './wecom-vendor-integrity.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function digest(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function createFixture(t) {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-vendor-integrity-'));
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));

  const first = 'upstream skill\n';
  const second = 'upstream reference\n';
  fs.mkdirSync(path.join(fixtureRoot, 'references', 'vendor', 'nested'), { recursive: true });
  fs.writeFileSync(path.join(fixtureRoot, 'references', 'vendor', 'SKILL.md'), first);
  fs.writeFileSync(path.join(fixtureRoot, 'references', 'vendor', 'nested', 'guide.md'), second);
  fs.writeFileSync(path.join(fixtureRoot, 'POLICY.md'), 'component override\n');
  writeJson(path.join(fixtureRoot, 'package.json'), { upstream: { commit: 'abc123' } });

  const manifest = {
    schemaVersion: 1,
    snapshots: [
      {
        id: 'fixture',
        repository: 'https://example.invalid/upstream.git',
        commit: 'abc123',
        packageCommitField: 'upstream.commit',
        upstreamRoot: 'skills',
        vendorRoot: 'references/vendor',
        files: {
          'SKILL.md': digest(first),
          'nested/guide.md': digest(second)
        }
      }
    ],
    knownOverrides: [
      {
        id: 'component-policy',
        rationale: 'The component owns its lifecycle policy.',
        paths: ['POLICY.md']
      }
    ]
  };
  const manifestPath = path.join(fixtureRoot, 'references', 'wecom-vendor-manifest.json');
  writeJson(manifestPath, manifest);

  return { fixtureRoot, manifest, manifestPath };
}

test('repository snapshots match their pinned upstream manifest', () => {
  const report = verifyWecomVendorIntegrity(root);

  assert.deepEqual(report.snapshots.map((snapshot) => snapshot.status), ['clean', 'clean']);
  assert.deepEqual(report.snapshots.map((snapshot) => snapshot.expectedFileCount), [97, 97]);
  assert.deepEqual(report.overrides.map((override) => override.status), ['known-override']);
});

test('clean snapshot passes and reports a known override separately', (t) => {
  const { fixtureRoot } = createFixture(t);
  const report = inspectWecomVendorIntegrity(fixtureRoot);

  assert.equal(report.ok, true);
  assert.equal(report.snapshots[0].status, 'clean');
  assert.equal(report.overrides[0].status, 'known-override');
});

test('modified vendored content is flagged without blaming the override', (t) => {
  const { fixtureRoot } = createFixture(t);
  fs.writeFileSync(path.join(fixtureRoot, 'references', 'vendor', 'SKILL.md'), 'changed\n');

  const report = inspectWecomVendorIntegrity(fixtureRoot);
  assert.equal(report.ok, false);
  assert.deepEqual(report.snapshots[0].modified, ['SKILL.md']);
  assert.equal(report.overrides[0].status, 'known-override');
  assert.throws(
    () => verifyWecomVendorIntegrity(fixtureRoot),
    /modified: SKILL\.md/
  );
});

test('missing and unexpected vendored files are observable', (t) => {
  const { fixtureRoot } = createFixture(t);
  fs.rmSync(path.join(fixtureRoot, 'references', 'vendor', 'nested', 'guide.md'));
  fs.writeFileSync(path.join(fixtureRoot, 'references', 'vendor', 'extra.md'), 'extra\n');

  const report = inspectWecomVendorIntegrity(fixtureRoot);
  assert.equal(report.ok, false);
  assert.deepEqual(report.snapshots[0].missing, ['nested/guide.md']);
  assert.deepEqual(report.snapshots[0].unexpected, ['extra.md']);
});

test('vendored symlinks are rejected instead of following outside content', (t) => {
  const { fixtureRoot } = createFixture(t);
  fs.symlinkSync(
    path.join(fixtureRoot, 'POLICY.md'),
    path.join(fixtureRoot, 'references', 'vendor', 'linked.md')
  );

  const report = inspectWecomVendorIntegrity(fixtureRoot);
  assert.equal(report.ok, false);
  assert.deepEqual(report.snapshots[0].symlinks, ['linked.md']);
  assert.match(report.snapshots[0].errors.at(-1), /symlinks are not allowed/);
});

test('package pin changes are flagged even when files still match', (t) => {
  const { fixtureRoot } = createFixture(t);
  writeJson(path.join(fixtureRoot, 'package.json'), { upstream: { commit: 'new-pin' } });

  const report = inspectWecomVendorIntegrity(fixtureRoot);
  assert.equal(report.ok, false);
  assert.equal(report.snapshots[0].pinMatches, false);
  assert.match(report.snapshots[0].errors[0], /expected abc123, got new-pin/);
});

test('an override cannot overlap vendored content and mask drift', (t) => {
  const { fixtureRoot, manifest, manifestPath } = createFixture(t);
  manifest.knownOverrides[0].paths.push('references/vendor/SKILL.md');
  writeJson(manifestPath, manifest);
  fs.writeFileSync(path.join(fixtureRoot, 'references', 'vendor', 'SKILL.md'), 'changed\n');

  const report = inspectWecomVendorIntegrity(fixtureRoot);
  assert.equal(report.ok, false);
  assert.deepEqual(report.snapshots[0].modified, ['SKILL.md']);
  assert.equal(report.overrides[0].status, 'invalid-override');
  assert.match(report.overrides[0].errors[0], /overlaps vendored content/);
});

test('malformed manifest entries fail closed without escaping the component root', (t) => {
  const { fixtureRoot, manifest, manifestPath } = createFixture(t);
  manifest.snapshots = [null, {
    id: 'unsafe',
    commit: 'abc123',
    packageCommitField: 42,
    vendorRoot: '../../outside',
    files: {}
  }];
  manifest.knownOverrides = [null];
  writeJson(manifestPath, manifest);

  const report = inspectWecomVendorIntegrity(fixtureRoot);
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((error) => error.includes('invalid id or vendorRoot')));
  assert.ok(report.errors.some((error) => error.includes('files manifest is empty')));
  assert.equal(report.overrides[0].status, 'invalid-override');
});
