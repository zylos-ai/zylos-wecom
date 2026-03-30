#!/usr/bin/env node

import { getConfig } from '../src/lib/config.js';
import {
  renderDocAuthGuide,
  resolveDocAuthGuideLocale
} from '../src/lib/i18n/doc-auth-guide.js';
import { parseLocaleArg } from '../src/lib/i18n/locale.js';
import {
  getDocConfigPaths,
  refreshDocConfigFromRuntime,
  resolveDocConfig
} from './wecom-doc-config.js';

const runtimeConfig = getConfig();
const locale = resolveDocAuthGuideLocale({
  cliLocale: parseLocaleArg(process.argv.slice(2)),
  configLocale: runtimeConfig?.message?.locale,
  envLocale: process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG
});
const { primary, fallback } = getDocConfigPaths();
const docConfig = await refreshDocConfigFromRuntime(runtimeConfig) || resolveDocConfig();

console.log(renderDocAuthGuide({
  locale,
  docConfig,
  checkedPaths: [primary, fallback]
}));
