import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const DEFAULT_MANIFEST = path.join('references', 'wecom-vendor-manifest.json');

function toPosix(relativePath) {
  return relativePath.split(path.sep).join('/');
}

function inspectTree(root) {
  if (!fs.existsSync(root)) return { files: [], symlinks: [] };

  const files = [];
  const symlinks = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(filePath);
      else if (entry.isFile()) files.push(toPosix(path.relative(root, filePath)));
      else if (entry.isSymbolicLink()) symlinks.push(toPosix(path.relative(root, filePath)));
    }
  };
  walk(root);
  return { files: files.sort(), symlinks: symlinks.sort() };
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function readNested(object, dottedPath) {
  return dottedPath.split('.').reduce((value, key) => value?.[key], object);
}

function isSafeRelativePath(relativePath) {
  if (typeof relativePath !== 'string' || relativePath.length === 0) return false;
  const normalized = path.posix.normalize(relativePath.replaceAll('\\', '/'));
  return normalized === relativePath
    && !normalized.startsWith('/')
    && normalized !== '..'
    && !normalized.startsWith('../');
}

function isInside(relativePath, root) {
  return relativePath === root || relativePath.startsWith(`${root}/`);
}

export function inspectWecomVendorIntegrity(
  componentRoot,
  { manifestPath = path.join(componentRoot, DEFAULT_MANIFEST) } = {}
) {
  const errors = [];
  let manifest;
  let pkg;

  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    return {
      ok: false,
      snapshots: [],
      overrides: [],
      errors: [`manifest unreadable: ${error.message}`]
    };
  }

  try {
    pkg = JSON.parse(fs.readFileSync(path.join(componentRoot, 'package.json'), 'utf8'));
  } catch (error) {
    return {
      ok: false,
      snapshots: [],
      overrides: [],
      errors: [`package.json unreadable: ${error.message}`]
    };
  }

  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.snapshots)) {
    errors.push('manifest must use schemaVersion 1 and define snapshots');
  }
  if (!Array.isArray(manifest.knownOverrides) || manifest.knownOverrides.length === 0) {
    errors.push('manifest must define at least one known override');
  }

  const vendorRoots = [];
  const snapshotEntries = Array.isArray(manifest.snapshots) ? manifest.snapshots : [];
  const snapshots = snapshotEntries.map((rawSnapshot) => {
    const snapshot = rawSnapshot && typeof rawSnapshot === 'object' ? rawSnapshot : {};
    const snapshotErrors = [];
    const expectedFiles = snapshot.files && typeof snapshot.files === 'object'
      ? Object.keys(snapshot.files).sort()
      : [];

    const validVendorRoot = isSafeRelativePath(snapshot.vendorRoot || '');
    if (!snapshot.id || !validVendorRoot) {
      snapshotErrors.push('invalid id or vendorRoot');
    } else {
      vendorRoots.push(snapshot.vendorRoot);
    }
    if (typeof snapshot.commit !== 'string'
      || typeof snapshot.packageCommitField !== 'string'
      || snapshot.commit.length === 0
      || snapshot.packageCommitField.length === 0) {
      snapshotErrors.push('missing commit or packageCommitField');
    }
    if (expectedFiles.length === 0) snapshotErrors.push('files manifest is empty');
    for (const file of expectedFiles) {
      if (!isSafeRelativePath(file) || !/^[a-f0-9]{64}$/.test(snapshot.files[file])) {
        snapshotErrors.push(`invalid manifest entry: ${file}`);
      }
    }

    const vendorRoot = path.join(
      componentRoot,
      validVendorRoot ? snapshot.vendorRoot : '__invalid__'
    );
    const { files: actualFiles, symlinks } = inspectTree(vendorRoot);
    const expectedSet = new Set(expectedFiles);
    const actualSet = new Set(actualFiles);
    const missing = expectedFiles.filter((file) => !actualSet.has(file));
    const unexpected = actualFiles.filter((file) => !expectedSet.has(file));
    const modified = [];
    const unreadable = [];
    for (const file of expectedFiles.filter((item) => actualSet.has(item))) {
      try {
        if (sha256(path.join(vendorRoot, ...file.split('/'))) !== snapshot.files[file]) {
          modified.push(file);
        }
      } catch (error) {
        unreadable.push(`${file} (${error.message})`);
      }
    }
    const actualCommit = typeof snapshot.packageCommitField === 'string'
      ? readNested(pkg, snapshot.packageCommitField)
      : undefined;
    const pinMatches = actualCommit === snapshot.commit;

    if (!pinMatches) {
      snapshotErrors.push(
        `pin mismatch at ${snapshot.packageCommitField}: expected ${snapshot.commit}, got ${actualCommit ?? 'missing'}`
      );
    }
    if (missing.length > 0) snapshotErrors.push(`missing: ${missing.join(', ')}`);
    if (modified.length > 0) snapshotErrors.push(`modified: ${modified.join(', ')}`);
    if (unexpected.length > 0) snapshotErrors.push(`unexpected: ${unexpected.join(', ')}`);
    if (symlinks.length > 0) snapshotErrors.push(`symlinks are not allowed: ${symlinks.join(', ')}`);
    if (unreadable.length > 0) snapshotErrors.push(`unreadable: ${unreadable.join(', ')}`);

    return {
      id: snapshot.id,
      repository: snapshot.repository,
      commit: snapshot.commit,
      vendorRoot: snapshot.vendorRoot,
      expectedFileCount: expectedFiles.length,
      actualFileCount: actualFiles.length,
      pinMatches,
      missing,
      modified,
      unexpected,
      symlinks,
      unreadable,
      status: snapshotErrors.length === 0 ? 'clean' : 'drift',
      errors: snapshotErrors
    };
  });

  const duplicateRoots = vendorRoots.filter(
    (root, index) => vendorRoots.indexOf(root) !== index
  );
  if (duplicateRoots.length > 0) {
    errors.push(`duplicate vendor roots: ${[...new Set(duplicateRoots)].join(', ')}`);
  }

  const overrideEntries = Array.isArray(manifest.knownOverrides)
    ? manifest.knownOverrides
    : [];
  const overrides = overrideEntries.map((rawOverride) => {
    const override = rawOverride && typeof rawOverride === 'object' ? rawOverride : {};
    const overrideErrors = [];
    const paths = Array.isArray(override.paths) ? override.paths : [];
    const unsafe = paths.filter((item) => !isSafeRelativePath(item));
    const overlaps = paths.filter((item) => vendorRoots.some((root) => isInside(item, root)));
    const missing = paths.filter((item) => {
      if (!isSafeRelativePath(item)) return false;
      try {
        return !fs.statSync(path.join(componentRoot, ...item.split('/'))).isFile();
      } catch {
        return true;
      }
    });

    if (!override.id || !override.rationale || paths.length === 0) {
      overrideErrors.push('override requires id, rationale, and paths');
    }
    if (unsafe.length > 0) overrideErrors.push(`unsafe paths: ${unsafe.join(', ')}`);
    if (overlaps.length > 0) {
      overrideErrors.push(`override overlaps vendored content: ${overlaps.join(', ')}`);
    }
    if (missing.length > 0) overrideErrors.push(`missing override paths: ${missing.join(', ')}`);

    return {
      id: override.id,
      rationale: override.rationale,
      paths,
      missing,
      status: overrideErrors.length === 0 ? 'known-override' : 'invalid-override',
      errors: overrideErrors
    };
  });

  for (const snapshot of snapshots) {
    errors.push(...snapshot.errors.map((error) => `${snapshot.id}: ${error}`));
  }
  for (const override of overrides) {
    errors.push(...override.errors.map((error) => `${override.id}: ${error}`));
  }

  return { ok: errors.length === 0, snapshots, overrides, errors };
}

export function verifyWecomVendorIntegrity(componentRoot, options) {
  const report = inspectWecomVendorIntegrity(componentRoot, options);
  if (!report.ok) {
    throw new Error(`vendored WeCom skill drift detected:\n- ${report.errors.join('\n- ')}`);
  }
  return report;
}
