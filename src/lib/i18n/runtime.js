import { resolveLocale } from './locale.js';

export function resolveRuntimeLocale(config, env = process.env) {
  return resolveLocale({
    configLocale: config?.message?.locale,
    envLocale: env.LC_ALL || env.LC_MESSAGES || env.LANG
  });
}

export function resolveWelcomeMessage(config, env = process.env) {
  const locale = resolveRuntimeLocale(config, env);
  const welcomeTexts = config?.message?.welcome_texts;
  const localized = welcomeTexts && typeof welcomeTexts === 'object'
    ? welcomeTexts[locale]
    : '';

  if (typeof localized === 'string' && localized.trim()) {
    return { locale, text: localized, source: 'localized' };
  }

  const legacy = config?.message?.welcome_text;
  if (typeof legacy === 'string' && legacy.trim()) {
    return { locale, text: legacy, source: 'legacy' };
  }

  return { locale, text: '', source: 'none' };
}
