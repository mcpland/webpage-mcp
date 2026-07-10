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

export function cleanWorkspace(rootDir, target) {
  const workspaceDirs = workspaceDirectories(rootDir);
  if (target === "dist") {
    for (const directory of [rootDir, ...workspaceDirs]) {
      removePath(path.join(directory, "dist"));
      removePath(path.join(directory, ".turbo"));
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
