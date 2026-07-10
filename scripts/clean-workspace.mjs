#!/usr/bin/env node

import console from "node:console";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

function workspaceDirectories(rootDir) {
  const directories = [];
  for (const group of ["app", "packages"]) {
    const groupDir = path.join(rootDir, group);
    if (!fs.existsSync(groupDir)) continue;
    for (const entry of fs.readdirSync(groupDir, { withFileTypes: true })) {
      if (entry.isDirectory())
        directories.push(path.join(groupDir, entry.name));
    }
  }
  return directories;
}

function removePath(targetPath) {
  fs.rmSync(targetPath, { recursive: true, force: true });
}

const COMMON_BUILD_OUTPUTS = ["dist", ".turbo", ".output", ".wxt", "coverage"];

const WORKSPACE_SPECIFIC_BUILD_OUTPUTS = [
  ["packages", "wasm-simd", "pkg"],
  ["packages", "wasm-simd", "target"],
];

export function cleanWorkspace(rootDir, target) {
  const workspaceDirs = workspaceDirectories(rootDir);
  if (target === "dist") {
    for (const directory of [rootDir, ...workspaceDirs]) {
      for (const outputName of COMMON_BUILD_OUTPUTS) {
        removePath(path.join(directory, outputName));
      }
    }
    for (const outputParts of WORKSPACE_SPECIFIC_BUILD_OUTPUTS) {
      removePath(path.join(rootDir, ...outputParts));
    }
    return;
  }
  if (target === "modules") {
    for (const directory of workspaceDirs) {
      removePath(path.join(directory, "node_modules"));
    }
    removePath(path.join(rootDir, "node_modules"));
    return;
  }
  throw new Error(`Unknown clean target: ${target || "<missing>"}`);
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    cleanWorkspace(
      path.resolve(fileURLToPath(new URL("..", import.meta.url))),
      process.argv[2],
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
