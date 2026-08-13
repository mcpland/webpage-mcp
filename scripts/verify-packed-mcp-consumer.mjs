import console from "node:console";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  lstat,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const MAX_PACKAGE_BYTES = 256 * 1024 * 1024;

function runNpm(args, cwd) {
  execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", args, {
    cwd,
    env: {
      ...process.env,
      npm_config_audit: "false",
      npm_config_fund: "false",
      npm_config_ignore_scripts: "true",
    },
    stdio: "inherit",
    windowsHide: true,
  });
}

function runNode(args, cwd) {
  return execFileSync(process.execPath, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: 30_000,
    windowsHide: true,
  });
}

async function main() {
  const packageArgument = process.argv[2];
  if (!packageArgument || process.argv.length !== 3) {
    throw new Error("Usage: verify-packed-mcp-consumer.mjs <webpage-mcp.tgz>");
  }
  const packagePath = resolve(packageArgument);
  const stats = await lstat(packagePath);
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.size <= 0 ||
    stats.size > MAX_PACKAGE_BYTES
  ) {
    throw new Error("MCP package must be a bounded regular tarball");
  }

  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const sourcePackage = JSON.parse(
    await readFile(join(repositoryRoot, "app/mcp-server/package.json"), "utf8"),
  );
  const installRoot = await mkdtemp(join(tmpdir(), "webpage-mcp-consumer-"));
  try {
    await writeFile(
      join(installRoot, "package.json"),
      `${JSON.stringify({ name: "webpage-mcp-consumer-smoke", version: "1.0.0", private: true }, null, 2)}\n`,
      "utf8",
    );
    runNpm(
      [
        "install",
        "--save-exact",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        packagePath,
      ],
      installRoot,
    );

    const installedRoot = join(installRoot, "node_modules/webpage-mcp");
    const installedPackage = JSON.parse(
      await readFile(join(installedRoot, "package.json"), "utf8"),
    );
    if (
      installedPackage.name !== sourcePackage.name ||
      installedPackage.version !== sourcePackage.version ||
      JSON.stringify(installedPackage.dependencies) !==
        JSON.stringify(sourcePackage.dependencies)
    ) {
      throw new Error(
        "installed MCP package metadata drifted from the source package",
      );
    }
    for (const [name, version] of Object.entries(sourcePackage.dependencies)) {
      const dependencyPackage = JSON.parse(
        await readFile(
          join(installRoot, "node_modules", ...name.split("/"), "package.json"),
          "utf8",
        ),
      );
      if (dependencyPackage.version !== version) {
        throw new Error(
          `fresh npm install resolved ${name}@${dependencyPackage.version}, expected ${version}`,
        );
      }
    }

    const runtimeRequire = createRequire(join(installedRoot, "package.json"));
    const installedMcpSdk = join(
      installRoot,
      "node_modules",
      "@modelcontextprotocol",
      "sdk",
    );
    const hiddenMcpSdk = join(
      installRoot,
      "node_modules",
      "@modelcontextprotocol",
      ".sdk-bundle-smoke",
    );
    await rename(installedMcpSdk, hiddenMcpSdk);
    try {
      runtimeRequire("./dist/mcp/register-tools.js");
      runtimeRequire("./dist/mcp/mcp-server-http.js");
    } finally {
      await rename(hiddenMcpSdk, installedMcpSdk);
    }

    const subcommandHelp = runNode(
      [
        join(installedRoot, "dist/cli.js"),
        "webpage-mcp-server",
        "--help",
      ],
      installRoot,
    );
    const standaloneHelp = runNode(
      [join(installedRoot, "dist/mcp/mcp-server-http.js"), "--help"],
      installRoot,
    );
    if (
      !subcommandHelp.includes("Streamable HTTP") ||
      !standaloneHelp.includes("Streamable HTTP")
    ) {
      throw new Error("installed remote MCP server commands failed their help smoke test");
    }

    runNpm(["audit", "--omit=dev", "--audit-level=low"], installRoot);
    console.log(
      `Verified fresh npm consumer install for webpage-mcp@${installedPackage.version}.`,
    );
  } finally {
    await rm(installRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
