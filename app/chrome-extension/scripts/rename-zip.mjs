#!/usr/bin/env node

import { access, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import pkg from "../package.json" with { type: "json" };

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultOutputDir = join(scriptDir, "..", ".output");

export async function renameZipArtifact({
  outputDir,
  browser,
  version,
  packageName,
}) {
  if (!/^[a-z0-9-]+$/i.test(browser)) {
    throw new Error(
      `Invalid browser artifact name: ${JSON.stringify(browser)}`,
    );
  }
  if (!/^[a-z0-9._-]+$/i.test(version)) {
    throw new Error(`Invalid extension version: ${JSON.stringify(version)}`);
  }
  if (!/^[a-z0-9._-]+$/i.test(packageName)) {
    throw new Error(
      `Invalid extension package name: ${JSON.stringify(packageName)}`,
    );
  }

  // WXT's default artifact template is exactly
  // {{name}}-{{version}}-{{browser}}.zip. Address that file directly so an
  // older, lexicographically later zip can never be selected by accident.
  const sourceName = `${packageName}-${version}-${browser}.zip`;
  const targetName = `${packageName}-${version}-${browser}-extension.zip`;
  const resolvedOutputDir = resolve(outputDir);
  const sourcePath = join(resolvedOutputDir, sourceName);
  const targetPath = join(resolvedOutputDir, targetName);

  try {
    await access(sourcePath);
  } catch {
    throw new Error(
      `Expected current WXT artifact ${sourcePath} was not found. Run "wxt zip" first.`,
    );
  }

  // Windows rename does not replace an existing destination. The exact source
  // above proves this run produced the artifact before removing a stale target.
  await rm(targetPath, { force: true });
  await rename(sourcePath, targetPath);
  return targetPath;
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const artifactPath = await renameZipArtifact({
    outputDir: defaultOutputDir,
    browser: process.argv[2] ?? "chrome",
    version: pkg.version,
    packageName: pkg.name,
  });
  console.log(`zip artifact: ${artifactPath}`);
}
