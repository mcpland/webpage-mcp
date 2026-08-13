import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  getRuntimeNodeModulesPathFile,
  installStableRuntimeDependencies,
  RUNTIME_REQUIRED_MODULE_IDS,
} from "./stable-runtime-dependencies";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

function isPathInside(parentPath: string, candidatePath: string): boolean {
  const relative = path.relative(parentPath, candidatePath);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

async function writeFixturePackage(
  nodeModulesDir: string,
  packageName: string,
  manifest: Record<string, unknown>,
  files: Record<string, string>,
): Promise<string> {
  const packageDir = path.join(nodeModulesDir, ...packageName.split("/"));
  await fs.mkdir(packageDir, { recursive: true });
  await fs.writeFile(
    path.join(packageDir, "package.json"),
    `${JSON.stringify({ name: packageName, version: "1.0.0", ...manifest })}\n`,
  );
  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = path.join(packageDir, relativePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, contents);
  }
  return packageDir;
}

describe("stable runtime dependencies", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => fs.rm(directory, { recursive: true, force: true })),
    );
  });

  it("remains self-contained after the source node_modules is deleted", async () => {
    const temporaryRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "webpage-mcp-stable-dependencies-"),
    );
    temporaryDirectories.push(temporaryRoot);

    const sourcePackageRoot = path.join(temporaryRoot, "source", "webpage-mcp");
    const sourceDistDir = path.join(sourcePackageRoot, "dist");
    const sourceNodeModulesDir = path.join(sourcePackageRoot, "node_modules");
    const runtimeDistDir = path.join(temporaryRoot, "runtime", "dist");
    await fs.mkdir(sourceDistDir, { recursive: true });
    await fs.mkdir(runtimeDistDir, { recursive: true });
    await fs.writeFile(
      path.join(sourceDistDir, "index.js"),
      "module.exports = {};\n",
    );
    await fs.writeFile(
      path.join(runtimeDistDir, "index.js"),
      "module.exports = {};\n",
    );

    const installedNodeModulesDir = await fs.realpath(
      path.join(packageRoot, "node_modules"),
    );
    await fs.symlink(
      installedNodeModulesDir,
      sourceNodeModulesDir,
      process.platform === "win32" ? "junction" : "dir",
    );

    const installed = await installStableRuntimeDependencies(
      sourceDistDir,
      runtimeDistDir,
    );
    const generationMtime = (
      await fs.stat(path.dirname(installed.nodeModulesDir))
    ).mtimeMs;
    const reused = await installStableRuntimeDependencies(
      sourceDistDir,
      runtimeDistDir,
    );

    expect(reused.reused).toBe(true);
    expect(reused.fingerprint).toBe(installed.fingerprint);
    expect(installed.packageCount).toBeGreaterThan(3);
    expect((await fs.stat(path.dirname(reused.nodeModulesDir))).mtimeMs).toBe(
      generationMtime,
    );

    await fs.rm(sourceNodeModulesDir);

    const configuredNodeModulesDir = (
      await fs.readFile(getRuntimeNodeModulesPathFile(runtimeDistDir), "utf8")
    ).trim();
    expect(path.resolve(configuredNodeModulesDir)).toBe(
      path.resolve(installed.nodeModulesDir),
    );
    expect(
      isPathInside(
        path.join(temporaryRoot, "runtime"),
        configuredNodeModulesDir,
      ),
    ).toBe(true);
    expect(
      isPathInside(installedNodeModulesDir, configuredNodeModulesDir),
    ).toBe(false);
    expect(configuredNodeModulesDir).not.toContain(sourceNodeModulesDir);

    const runtimeRequire = createRequire(
      path.join(configuredNodeModulesDir, ".test-runtime.cjs"),
    );
    const canonicalNodeModulesDir = await fs.realpath(configuredNodeModulesDir);
    for (const moduleId of RUNTIME_REQUIRED_MODULE_IDS) {
      const resolvedPath = await fs.realpath(runtimeRequire.resolve(moduleId));
      expect(isPathInside(canonicalNodeModulesDir, resolvedPath)).toBe(true);
    }

    const BetterSqlite3 = runtimeRequire("better-sqlite3") as new (
      filename: string,
    ) => { close: () => void };
    const database = new BetterSqlite3(":memory:");
    database.close();

    const recovered = await installStableRuntimeDependencies(
      runtimeDistDir,
      runtimeDistDir,
      { allowExistingGenerationWithoutSource: true },
    );
    expect(recovered.reused).toBe(true);
    expect(recovered.nodeModulesDir).toBe(installed.nodeModulesDir);

    if (process.platform !== "win32") {
      expect((await fs.stat(configuredNodeModulesDir)).mode & 0o777).toBe(
        0o700,
      );
      expect(
        (await fs.stat(getRuntimeNodeModulesPathFile(runtimeDistDir))).mode &
          0o777,
      ).toBe(0o600);
    }
  }, 120_000);

  it("reconstructs npm-style hoisted and nested dependency resolution", async () => {
    const temporaryRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "webpage-mcp-npm-dependencies-"),
    );
    temporaryDirectories.push(temporaryRoot);

    const sourcePackageRoot = path.join(temporaryRoot, "source", "webpage-mcp");
    const sourceDistDir = path.join(sourcePackageRoot, "dist");
    const sourceNodeModulesDir = path.join(sourcePackageRoot, "node_modules");
    const runtimeDistDir = path.join(temporaryRoot, "runtime", "dist");
    await fs.mkdir(sourceDistDir, { recursive: true });
    await fs.mkdir(runtimeDistDir, { recursive: true });
    await fs.writeFile(
      path.join(sourceDistDir, "index.js"),
      "module.exports = {};\n",
    );
    await fs.writeFile(
      path.join(runtimeDistDir, "index.js"),
      "module.exports = {};\n",
    );

    await writeFixturePackage(
      sourceNodeModulesDir,
      "drizzle-orm",
      {
        exports: {
          ".": "./index.cjs",
          "./sqlite-core": "./sqlite-core.cjs",
        },
        dependencies: {
          "runtime-hoisted": "1.0.0",
          "runtime-leaf": "2.0.0",
        },
      },
      {
        "index.cjs": [
          'exports.hoisted = require("runtime-hoisted");',
          'exports.leaf = require("runtime-leaf");',
          "",
        ].join("\n"),
        "sqlite-core.cjs": "module.exports = {};\n",
      },
    );
    const betterSqliteDir = await writeFixturePackage(
      sourceNodeModulesDir,
      "better-sqlite3",
      { main: "index.cjs", dependencies: { "runtime-leaf": "1.0.0" } },
      {
        "index.cjs": [
          'const leaf = require("runtime-leaf");',
          "class BetterSqlite3 { close() {} }",
          "BetterSqlite3.leaf = leaf;",
          "module.exports = BetterSqlite3;",
          "",
        ].join("\n"),
      },
    );
    await writeFixturePackage(
      path.join(betterSqliteDir, "node_modules"),
      "runtime-leaf",
      {},
      { "index.js": 'module.exports = "nested";\n' },
    );
    await writeFixturePackage(
      sourceNodeModulesDir,
      "runtime-hoisted",
      {},
      { "index.js": 'module.exports = "hoisted";\n' },
    );
    await writeFixturePackage(
      sourceNodeModulesDir,
      "runtime-leaf",
      { version: "2.0.0" },
      { "index.js": 'module.exports = "drizzle";\n' },
    );
    await writeFixturePackage(
      sourceNodeModulesDir,
      "cross-spawn",
      {},
      { "index.js": "module.exports = {};\n" },
    );
    await writeFixturePackage(
      sourceNodeModulesDir,
      "uuid",
      {},
      { "index.js": "module.exports = {};\n" },
    );
    await writeFixturePackage(
      sourceNodeModulesDir,
      "zod",
      { exports: { "./v4": "./v4/index.cjs" } },
      { "v4/index.cjs": "module.exports = {};\n" },
    );

    const concurrentInstalls = await Promise.all([
      installStableRuntimeDependencies(sourceDistDir, runtimeDistDir),
      installStableRuntimeDependencies(sourceDistDir, runtimeDistDir),
    ]);
    const installed = concurrentInstalls[0];
    expect(
      new Set(concurrentInstalls.map((result) => result.fingerprint)).size,
    ).toBe(1);
    expect(concurrentInstalls.filter((result) => !result.reused)).toHaveLength(
      1,
    );
    await fs.rm(sourceNodeModulesDir, { recursive: true });

    const runtimeRequire = createRequire(
      path.join(installed.nodeModulesDir, ".test-npm-runtime.cjs"),
    );
    const BetterSqlite3 = runtimeRequire("better-sqlite3") as {
      new (filename: string): { close: () => void };
      leaf: string;
    };
    expect(BetterSqlite3.leaf).toBe("nested");
    const Drizzle = runtimeRequire("drizzle-orm") as {
      hoisted: string;
      leaf: string;
    };
    expect(Drizzle.hoisted).toBe("hoisted");
    expect(Drizzle.leaf).toBe("drizzle");
    expect(runtimeRequire("runtime-hoisted")).toBe("hoisted");
    for (const moduleId of RUNTIME_REQUIRED_MODULE_IDS) {
      expect(
        isPathInside(
          await fs.realpath(installed.nodeModulesDir),
          await fs.realpath(runtimeRequire.resolve(moduleId)),
        ),
      ).toBe(true);
    }
  });
});
