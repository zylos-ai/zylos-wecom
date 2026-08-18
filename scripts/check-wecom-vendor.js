#!/usr/bin/env node

import path from 'path';
import { fileURLToPath } from 'url';

import { inspectWecomVendorIntegrity } from '../src/lib/wecom-vendor-integrity.js';

const componentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const report = inspectWecomVendorIntegrity(componentRoot);

for (const snapshot of report.snapshots) {
  if (snapshot.status === 'clean') {
    console.log(
      `[zylos-wecom] vendor clean: ${snapshot.id} (${snapshot.expectedFileCount} files, ${snapshot.commit})`
    );
  } else {
    console.error(`[zylos-wecom] vendor drift: ${snapshot.id}`);
  }
}

for (const override of report.overrides) {
  const output = override.status === 'known-override' ? console.log : console.error;
  output(`[zylos-wecom] ${override.status}: ${override.id} - ${override.rationale}`);
}

if (!report.ok) {
  console.error('[zylos-wecom] verification failed:');
  for (const error of report.errors) console.error(`  - ${error}`);
  process.exitCode = 1;
}
