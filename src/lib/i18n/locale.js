const DEFAULT_LOCALE = 'zh-CN';

const LOCALE_ALIASES = new Map([
  ['zh', 'zh-CN'],
  ['zh-cn', 'zh-CN'],
  ['zh-hans', 'zh-CN'],
  ['zh-hans-cn', 'zh-CN'],
  ['en', 'en-US'],
  ['en-us', 'en-US']
]);

export function normalizeLocale(input) {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  const canonical = trimmed
    .split('.')[0]
    .replace(/_/g, '-')
    .toLowerCase();

  const alias = LOCALE_ALIASES.get(canonical);
  if (alias) return alias;

  return null;
}

export function resolveLocale({ cliLocale, configLocale, envLocale } = {}) {
  return (
    normalizeLocale(cliLocale)
    || normalizeLocale(configLocale)
    || normalizeLocale(envLocale)
    || DEFAULT_LOCALE
  );
}

export function parseLocaleArg(argv = []) {
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--locale') {
      return argv[index + 1] || '';
    }
    if (value.startsWith('--locale=')) {
      return value.slice('--locale='.length);
    }
  }
  return '';
}

export function stripLocaleArg(argv = []) {
  const stripped = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--locale') {
      index += 1;
      continue;
    }
    if (value.startsWith('--locale=')) {
      continue;
    }
    stripped.push(value);
  }
  return stripped;
}
