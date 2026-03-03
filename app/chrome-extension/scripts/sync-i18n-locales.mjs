#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');
const localesRoot = path.join(root, '_locales');
const enPath = path.join(localesRoot, 'en', 'messages.json');

const ignored = new Set(['_locales', 'dist', 'node_modules', '.output', '.wxt']);
const sourceExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.html']);
const sourceFiles = [];

const localeToLangCode = {
  en: 'en',
  de: 'de',
  ja: 'ja',
  ko: 'ko',
  zh_CN: 'zh-CN',
  zh_TW: 'zh-TW',
};

function inferLangCode(locale) {
  if (localeToLangCode[locale]) return localeToLangCode[locale];
  if (locale.includes('_')) return locale.replace('_', '-');
  return locale;
}

function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith('.')) continue;
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      if (!ignored.has(name)) walk(full);
      continue;
    }
    if (sourceExtensions.has(path.extname(name))) {
      sourceFiles.push(full);
    }
  }
}

walk(root);

const keyDefaults = new Map();
const usedKeys = new Set();

function recordKey(key, defaultValue) {
  if (!key || key.startsWith('@@')) return;
  usedKeys.add(key);
  if (defaultValue && !keyDefaults.has(key)) {
    keyDefaults.set(key, defaultValue);
  }
}

for (const file of sourceFiles) {
  const ext = path.extname(file);
  const content = fs.readFileSync(file, 'utf8');

  const msgRegex = /__MSG_([A-Za-z0-9_@]+)__/g;
  let msgMatch;
  while ((msgMatch = msgRegex.exec(content)) !== null) {
    recordKey(msgMatch[1]);
  }

  if (ext === '.html') continue;

  const scriptKind = ext === '.ts' || ext === '.tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.JS;
  const sourceFile = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, scriptKind);

  function visit(node) {
    if (ts.isCallExpression(node)) {
      const expr = node.expression;
      let callee = '';
      if (ts.isIdentifier(expr)) {
        callee = expr.text;
      } else if (ts.isPropertyAccessExpression(expr)) {
        callee = expr.getText(sourceFile);
      }

      if (callee === 'getMessage' || callee === 'chrome.i18n.getMessage') {
        const arg = node.arguments[0];
        if (arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) {
          recordKey(arg.text);
        }
      }

      if (callee === 't') {
        const keyArg = node.arguments[0];
        const defaultArg = node.arguments[1];
        if (keyArg && (ts.isStringLiteral(keyArg) || ts.isNoSubstitutionTemplateLiteral(keyArg))) {
          let defaultValue;
          if (
            defaultArg &&
            (ts.isStringLiteral(defaultArg) || ts.isNoSubstitutionTemplateLiteral(defaultArg))
          ) {
            defaultValue = defaultArg.text;
          }
          recordKey(keyArg.text, defaultValue);
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
}

const explicitDefaults = {
  builderPageTitle: 'Workflow Builder - webpage-mcp-server',
  popupPageTitle: 'webpage-mcp-server',
  sidepanelPageTitle: 'webpage-mcp-server',
  welcomePageTitle: 'Welcome - webpage-mcp-server',
  commandToggleWebEditorDesc: 'Toggle web editor mode',
  commandToggleQuickPanelDesc: 'Toggle quick panel',
};

for (const [k, v] of Object.entries(explicitDefaults)) {
  if (!keyDefaults.has(k)) keyDefaults.set(k, v);
  usedKeys.add(k);
}

function normalizeMessageEntry(entry) {
  if (!entry || typeof entry !== 'object') return entry;
  let message = typeof entry.message === 'string' ? entry.message : String(entry.message || '');

  if (/\$[A-Z0-9_]+\$/i.test(message)) {
    return { ...entry, message };
  }

  const matches = [...message.matchAll(/\{(\d+)\}/g)].map((m) => Number(m[1]));
  if (matches.length === 0) {
    return { ...entry, message };
  }

  const unique = [...new Set(matches)].sort((a, b) => a - b);
  const placeholders = { ...(entry.placeholders || {}) };

  for (const idx of unique) {
    const name = `arg${idx + 1}`;
    const token = `$${name.toUpperCase()}$`;
    message = message.replace(new RegExp(`\\{${idx}\\}`, 'g'), token);
    if (!placeholders[name]) {
      placeholders[name] = { content: `$${idx + 1}$`, example: String(idx + 1) };
    }
  }

  return { ...entry, message, placeholders };
}

function sortObjectByKeys(obj) {
  return Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)));
}

function clonePlaceholders(placeholders) {
  if (!placeholders || typeof placeholders !== 'object') return undefined;
  return JSON.parse(JSON.stringify(placeholders));
}

function protectTokens(text) {
  const tokens = [];
  let protectedText = text;

  protectedText = protectedText.replace(/\$[A-Z0-9_]+\$/g, (match) => {
    const idx = tokens.push(match) - 1;
    return `__PH${idx}__`;
  });

  protectedText = protectedText.replace(/\{\d+\}/g, (match) => {
    const idx = tokens.push(match) - 1;
    return `__PH${idx}__`;
  });

  return { protectedText, tokens };
}

function restoreTokens(text, tokens) {
  let output = text;
  tokens.forEach((token, idx) => {
    output = output.replace(new RegExp(`__PH${idx}__`, 'g'), token);
  });
  return output;
}

const translationCacheByLang = new Map();

async function translate(text, targetLang) {
  if (!text || targetLang === 'en') return text;

  let cache = translationCacheByLang.get(targetLang);
  if (!cache) {
    cache = new Map();
    translationCacheByLang.set(targetLang, cache);
  }

  if (cache.has(text)) {
    return cache.get(text);
  }

  const { protectedText, tokens } = protectTokens(text);
  const url =
    'https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&dt=t' +
    `&tl=${encodeURIComponent(targetLang)}` +
    `&q=${encodeURIComponent(protectedText)}`;

  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const translated = Array.isArray(data?.[0])
      ? data[0].map((part) => part?.[0] || '').join('')
      : text;
    const restored = restoreTokens(translated || text, tokens);
    cache.set(text, restored);
    return restored;
  } catch {
    cache.set(text, text);
    return text;
  }
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (true) {
      const current = nextIndex;
      nextIndex += 1;
      if (current >= items.length) return;
      results[current] = await worker(items[current], current);
    }
  }

  const runners = Array.from({ length: Math.max(1, limit) }, () => runWorker());
  await Promise.all(runners);
  return results;
}

const en = JSON.parse(fs.readFileSync(enPath, 'utf8'));

for (const key of usedKeys) {
  if (!en[key]) {
    en[key] = {
      message: keyDefaults.get(key) || key,
      description: 'Auto-generated i18n message',
    };
  }
}

for (const [key, entry] of Object.entries(en)) {
  en[key] = normalizeMessageEntry(entry);
}

const sortedEn = sortObjectByKeys(en);
fs.writeFileSync(enPath, `${JSON.stringify(sortedEn, null, 2)}\n`);

const localeDirs = fs
  .readdirSync(localesRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((locale) => fs.existsSync(path.join(localesRoot, locale, 'messages.json')))
  .sort();

const allLocaleKeys = Object.keys(sortedEn);
const localeSummary = [];

for (const locale of localeDirs) {
  if (locale === 'en') {
    localeSummary.push({ locale, added: 0, keys: allLocaleKeys.length });
    continue;
  }

  const localePath = path.join(localesRoot, locale, 'messages.json');
  const localeData = JSON.parse(fs.readFileSync(localePath, 'utf8'));
  const targetLang = inferLangCode(locale);

  const missingKeys = allLocaleKeys.filter((key) => !localeData[key]);

  await mapLimit(missingKeys, 8, async (key) => {
    const enEntry = sortedEn[key];
    const fallbackMessage = String(enEntry?.message || keyDefaults.get(key) || key);
    const translatedMessage = await translate(fallbackMessage, targetLang);

    localeData[key] = {
      message: translatedMessage,
      description:
        locale === 'zh_CN'
          ? '自动生成的 i18n 文案'
          : locale === 'zh_TW'
            ? '自動生成的 i18n 文案'
            : 'Auto-generated localized message',
    };

    const placeholders = clonePlaceholders(enEntry?.placeholders);
    if (placeholders) {
      localeData[key].placeholders = placeholders;
    }
  });

  for (const key of allLocaleKeys) {
    const enEntry = sortedEn[key];
    const localeEntry = localeData[key];
    if (!localeEntry) continue;

    if (!localeEntry.message || !String(localeEntry.message).trim()) {
      localeEntry.message = String(enEntry.message || key);
    }

    if (!localeEntry.description) {
      localeEntry.description =
        locale === 'zh_CN'
          ? '自动生成的 i18n 文案'
          : locale === 'zh_TW'
            ? '自動生成的 i18n 文案'
            : 'Auto-generated localized message';
    }

    if (enEntry?.placeholders && !localeEntry.placeholders) {
      localeEntry.placeholders = clonePlaceholders(enEntry.placeholders);
    }

    localeData[key] = normalizeMessageEntry(localeEntry);
  }

  const sortedLocaleData = sortObjectByKeys(localeData);
  fs.writeFileSync(localePath, `${JSON.stringify(sortedLocaleData, null, 2)}\n`);

  localeSummary.push({ locale, added: missingKeys.length, keys: Object.keys(sortedLocaleData).length });
}

console.log(`Updated locale base (en): ${Object.keys(sortedEn).length} keys`);
for (const row of localeSummary) {
  console.log(`- ${row.locale}: +${row.added}, total ${row.keys}`);
}
