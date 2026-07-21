import console from "node:console";
import { execFile } from "node:child_process";
import { Buffer } from "node:buffer";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadMcpBundleComponents } from "./mcp-bundle-components.mjs";

const MAX_AUDIT_OUTPUT_BYTES = 8 * 1024 * 1024;

export function findMcpBundleAdvisories(report, components) {
  if (
    report === null ||
    typeof report !== "object" ||
    Array.isArray(report) ||
    report.metadata?.vulnerabilities === undefined ||
    report.advisories === null ||
    typeof report.advisories !== "object" ||
    Array.isArray(report.advisories)
  ) {
    throw new Error("pnpm audit returned an unsupported report");
  }
  const matches = [];
  for (const advisory of Object.values(report.advisories)) {
    const version = components.get(advisory.module_name);
    if (
      version !== undefined &&
      Array.isArray(advisory.findings) &&
      advisory.findings.some((finding) => finding?.version === version)
    ) {
      matches.push({
        name: advisory.module_name,
        version,
        severity: advisory.severity,
        title: advisory.title,
      });
    }
  }
  return matches.sort((left, right) => left.name.localeCompare(right.name));
}

function auditWorkspace(rootDir) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      "pnpm",
      ["audit", "--json"],
      {
        cwd: rootDir,
        encoding: "utf8",
        maxBuffer: MAX_AUDIT_OUTPUT_BYTES,
        timeout: 60_000,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (
          Buffer.byteLength(stdout) > MAX_AUDIT_OUTPUT_BYTES ||
          Buffer.byteLength(stderr) > MAX_AUDIT_OUTPUT_BYTES
        ) {
          rejectPromise(
            new Error("pnpm audit output exceeded its byte budget"),
          );
          return;
        }
        let report;
        try {
          report = JSON.parse(stdout);
        } catch {
          rejectPromise(
            new Error(
              `pnpm audit failed without a valid report (code=${String(error?.code ?? "unknown")}, stderrBytes=${Buffer.byteLength(stderr)}; contents withheld)`,
            ),
          );
          return;
        }
        resolvePromise(report);
      },
    );
  });
}

const isMain =
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  auditWorkspace(rootDir)
    .then((report) => {
      const components = loadMcpBundleComponents(rootDir);
      const advisories = findMcpBundleAdvisories(report, components);
      if (advisories.length > 0) {
        throw new Error(
          `MCP bundled dependencies have active advisories: ${advisories
            .map(
              ({ name, version, severity }) =>
                `${name}@${version} (${severity})`,
            )
            .join(", ")}`,
        );
      }
      console.log(
        `Audited ${components.size} MCP bundled dependency versions.`,
      );
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
