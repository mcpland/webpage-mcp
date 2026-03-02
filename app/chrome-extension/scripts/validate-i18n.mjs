#!/usr/bin/env node

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const extensionRoot = path.resolve(__dirname, '..');
const localesRoot = path.join(extensionRoot, '_locales');
const requiredLocales = ['en', 'zh_CN'];
const sourceExtensions = new Set(['.ts', '.tsx', '.js', '.jsx']);
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
  ];

  for (const filePath of files) {
    const content = readFileSync(filePath, 'utf8');
    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        keys.add(match[2]);
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

for (const locale of requiredLocales) {
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
const zhKeys = new Set(Object.keys(localeData.zh_CN));
const missingInZh = diffKeys(enKeys, zhKeys);
const missingInEn = diffKeys(zhKeys, enKeys);

if (missingInZh.length > 0) {
  errors.push(
    `Missing keys in zh_CN (${missingInZh.length}): ${missingInZh.slice(0, 12).join(', ')}${missingInZh.length > 12 ? ', ...' : ''}`,
  );
}
if (missingInEn.length > 0) {
  errors.push(
    `Missing keys in en (${missingInEn.length}): ${missingInEn.slice(0, 12).join(', ')}${missingInEn.length > 12 ? ', ...' : ''}`,
  );
}

const sourceFiles = collectSourceFiles(extensionRoot);
const usedKeys = collectI18nKeysFromCode(sourceFiles);
const missingUsedInEn = diffKeys(usedKeys, enKeys);
const missingUsedInZh = diffKeys(usedKeys, zhKeys);

if (missingUsedInEn.length > 0) {
  errors.push(
    `Keys used in code but missing in en (${missingUsedInEn.length}): ${missingUsedInEn.slice(0, 12).join(', ')}${missingUsedInEn.length > 12 ? ', ...' : ''}`,
  );
}
if (missingUsedInZh.length > 0) {
  errors.push(
    `Keys used in code but missing in zh_CN (${missingUsedInZh.length}): ${missingUsedInZh.slice(0, 12).join(', ')}${missingUsedInZh.length > 12 ? ', ...' : ''}`,
  );
}

if (errors.length > 0) {
  fail(errors);
}

console.log(
  `[i18n] OK: en and zh_CN are in sync (${enKeys.size} keys), and ${usedKeys.size} code-referenced keys are present in both locales.`,
);
