import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const nextVersion = process.argv[2]?.trim();

if (!nextVersion) {
  console.error("Usage: node ./scripts/set-app-version.mjs <version>");
  process.exit(1);
}

const VERSION_PATTERN =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

if (!VERSION_PATTERN.test(nextVersion)) {
  console.error(`Invalid version: ${nextVersion}`);
  process.exit(1);
}

const packageJsonPaths = [
  resolve("app/chrome-extension/package.json"),
  resolve("app/mcp-server/package.json"),
];

for (const packageJsonPath of packageJsonPaths) {
  const source = await readFile(packageJsonPath, "utf8");
  const pkg = JSON.parse(source);
  pkg.version = nextVersion;
  await writeFile(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
  console.log(`Updated ${packageJsonPath} -> ${nextVersion}`);
}
