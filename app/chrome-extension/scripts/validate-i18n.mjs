#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const extensionRoot = path.resolve(__dirname, '..');
const localesRoot = path.join(extensionRoot, '_locales');
const requiredBaselineLocales = ['en', 'zh_CN'];
const sourceExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.html']);
const ignoredDirectories = new Set(['_locales', 'dist', 'node_modules', '.output', '.wxt']);

function readLocaleMessages(locale) {
  const filePath = path.join(localesRoot, locale, 'messages.json');
  const content = readFileSync(filePath, 'utf8');
  const data = JSON.parse(content);
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`Locale file is not a valid object: ${filePath}`);
  }
  return data;
}

function discoverLocales() {
  return readdirSync(localesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .filter((locale) => existsSync(path.join(localesRoot, locale, 'messages.json')))
    .sort();
}

function diffKeys(sourceKeys, targetKeys) {
  return [...sourceKeys].filter((key) => !targetKeys.has(key)).sort();
}

function collectSourceFiles(dir, files = []) {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.')) {
      continue;
    }
    const absolutePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) {
        collectSourceFiles(absolutePath, files);
      }
      continue;
    }
    if (sourceExtensions.has(path.extname(entry.name))) {
      files.push(absolutePath);
    }
  }
  return files;
}

function collectI18nKeysFromCode(files) {
  const keys = new Set();
  const patterns = [
    /\bgetMessage\(\s*(['"`])([^'"`]+)\1/g,
    /chrome\.i18n\.getMessage\(\s*(['"`])([^'"`]+)\1/g,
    /\bt\(\s*(['"`])([^'"`]+)\1\s*,/g,
    /__MSG_([A-Za-z0-9_@]+)__/g,
  ];

  for (const filePath of files) {
    const content = readFileSync(filePath, 'utf8');
    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        const key = match[2] || match[1];
        if (!key || key.startsWith('@@')) {
          continue;
        }
        keys.add(key);
      }
      pattern.lastIndex = 0;
    }
  }

  return keys;
}

function fail(errors) {
  console.error('[i18n] Validation failed:');
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

const errors = [];
const localeData = {};
const discoveredLocales = discoverLocales();

for (const locale of requiredBaselineLocales) {
  if (!discoveredLocales.includes(locale)) {
    errors.push(`Required locale is missing: ${locale}`);
  }
}

if (errors.length > 0) {
  fail(errors);
}

for (const locale of discoveredLocales) {
  try {
    localeData[locale] = readLocaleMessages(locale);
  } catch (error) {
    errors.push(`Unable to load ${locale}/messages.json: ${error.message}`);
  }
}

if (errors.length > 0) {
  fail(errors);
}

const enKeys = new Set(Object.keys(localeData.en));

for (const locale of discoveredLocales) {
  if (locale === 'en') {
    continue;
  }
  const localeKeys = new Set(Object.keys(localeData[locale]));
  const missingInLocale = diffKeys(enKeys, localeKeys);
  const extraInLocale = diffKeys(localeKeys, enKeys);

  if (missingInLocale.length > 0) {
    errors.push(
      `Missing keys in ${locale} (${missingInLocale.length}): ${missingInLocale.slice(0, 12).join(', ')}${missingInLocale.length > 12 ? ', ...' : ''}`,
    );
  }

  if (extraInLocale.length > 0) {
    errors.push(
      `Extra keys in ${locale} not in en (${extraInLocale.length}): ${extraInLocale.slice(0, 12).join(', ')}${extraInLocale.length > 12 ? ', ...' : ''}`,
    );
  }
}

const sourceFiles = collectSourceFiles(extensionRoot);
const usedKeys = collectI18nKeysFromCode(sourceFiles);

for (const locale of discoveredLocales) {
  const localeKeys = new Set(Object.keys(localeData[locale]));
  const missingUsed = diffKeys(usedKeys, localeKeys);
  if (missingUsed.length > 0) {
    errors.push(
      `Keys used in code but missing in ${locale} (${missingUsed.length}): ${missingUsed.slice(0, 12).join(', ')}${missingUsed.length > 12 ? ', ...' : ''}`,
    );
  }
}

if (errors.length > 0) {
  fail(errors);
}

console.log(
  `[i18n] OK: ${discoveredLocales.join(', ')} are in sync with en (${enKeys.size} keys), and ${usedKeys.size} code-referenced keys are present in all locales.`,
);
