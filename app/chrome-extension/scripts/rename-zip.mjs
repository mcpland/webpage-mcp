#!/usr/bin/env node

import { readdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pkg from "../package.json" with { type: "json" };

const scriptDir = dirname(fileURLToPath(import.meta.url));
const outputDir = join(scriptDir, "..", ".output");
const browser = process.argv[2] ?? "chrome";
const version = pkg.version;

const outputEntries = await readdir(outputDir);
const zipNames = outputEntries
  .filter((name) => name.endsWith(".zip") && name.includes(`-${browser}`))
  .sort();

if (zipNames.length === 0) {
  throw new Error(
    `No ${browser} zip artifact found in ${outputDir}. Run "wxt zip" first.`,
  );
}

const sourceName = zipNames[zipNames.length - 1];
const targetName = `webpage-mcp-connector-${version}-${browser}-extension.zip`;

if (sourceName !== targetName) {
  await rename(join(outputDir, sourceName), join(outputDir, targetName));
}

console.log(`zip artifact: ${join(outputDir, targetName)}`);
