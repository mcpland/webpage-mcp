import console from "node:console";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { validateUnifiedReleaseVersion } from "./unified-release-version.mjs";

export async function setAppVersion({ rootDir = process.cwd(), version } = {}) {
  const nextVersion = validateUnifiedReleaseVersion(
    version,
    "Unified app version",
  );
  const packageJsonPaths = [
    resolve(rootDir, "app/chrome-extension/package.json"),
    resolve(rootDir, "app/mcp-server/package.json"),
  ];
  const shrinkwrapPath = resolve(rootDir, "app/mcp-server/npm-shrinkwrap.json");
  const packages = await Promise.all(
    packageJsonPaths.map(async (packageJsonPath) => ({
      packageJsonPath,
      pkg: JSON.parse(await readFile(packageJsonPath, "utf8")),
    })),
  );
  const shrinkwrap = JSON.parse(await readFile(shrinkwrapPath, "utf8"));
  if (
    !shrinkwrap ||
    typeof shrinkwrap !== "object" ||
    Array.isArray(shrinkwrap) ||
    !shrinkwrap.packages ||
    typeof shrinkwrap.packages !== "object" ||
    Array.isArray(shrinkwrap.packages) ||
    !shrinkwrap.packages[""] ||
    typeof shrinkwrap.packages[""] !== "object" ||
    Array.isArray(shrinkwrap.packages[""])
  ) {
    throw new Error(
      "MCP npm-shrinkwrap.json must contain a root package entry",
    );
  }

  shrinkwrap.version = nextVersion;
  shrinkwrap.packages[""].version = nextVersion;

  for (const { packageJsonPath, pkg } of packages) {
    pkg.version = nextVersion;
    await writeFile(
      packageJsonPath,
      `${JSON.stringify(pkg, null, 2)}\n`,
      "utf8",
    );
    console.log(`Updated ${packageJsonPath} -> ${nextVersion}`);
  }
  await writeFile(
    shrinkwrapPath,
    `${JSON.stringify(shrinkwrap, null, 2)}\n`,
    "utf8",
  );
  console.log(`Updated ${shrinkwrapPath} -> ${nextVersion}`);
}

async function main() {
  const nextVersion = process.argv[2]?.trim();
  if (!nextVersion) {
    throw new Error("Usage: node ./scripts/set-app-version.mjs <stable-x.y.z>");
  }
  await setAppVersion({ version: nextVersion });
}

const isMain =
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
