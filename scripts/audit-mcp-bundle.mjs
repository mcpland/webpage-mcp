import console from "node:console";
import { execFile } from "node:child_process";
import { Buffer } from "node:buffer";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadMcpBundleComponents } from "./mcp-bundle-components.mjs";
import {
  partitionMitigatedAdvisories,
  verifyInstalledClaudeSdkRuntime,
} from "./claude-sdk-runtime-policy.mjs";

const MAX_AUDIT_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_EMBEDDED_AUDIT_OUTPUT_BYTES = 1024 * 1024;
const EMBEDDED_AUDIT_URL =
  "https://registry.npmjs.org/-/npm/v1/security/advisories/bulk";
const GITHUB_ADVISORY_URL_PATTERN =
  /^https:\/\/github\.com\/advisories\/(GHSA-[a-z0-9-]+)$/;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

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
        githubAdvisoryId: advisory.github_advisory_id,
      });
    }
  }
  return matches.sort((left, right) => left.name.localeCompare(right.name));
}

export function findEmbeddedComponentAdvisories(report, components) {
  if (!isRecord(report)) {
    throw new Error(
      "npm embedded-component audit returned an unsupported report",
    );
  }
  const matches = [];
  const seen = new Set();
  for (const [name, advisories] of Object.entries(report)) {
    const version = components.get(name);
    if (version === undefined || !Array.isArray(advisories)) {
      throw new Error(
        "npm embedded-component audit returned an unsupported report",
      );
    }
    for (const advisory of advisories) {
      const advisoryId =
        isRecord(advisory) && typeof advisory.url === "string"
          ? GITHUB_ADVISORY_URL_PATTERN.exec(advisory.url)?.[1]
          : undefined;
      if (
        !advisoryId ||
        typeof advisory.title !== "string" ||
        advisory.title.length === 0 ||
        advisory.title.length > 4096 ||
        typeof advisory.severity !== "string" ||
        advisory.severity.length === 0 ||
        seen.has(`${name}\0${advisoryId}`)
      ) {
        throw new Error(
          "npm embedded-component audit returned an unsupported report",
        );
      }
      seen.add(`${name}\0${advisoryId}`);
      matches.push({
        name,
        version,
        severity: advisory.severity,
        title: advisory.title,
        githubAdvisoryId: advisoryId,
      });
    }
  }
  return matches.sort((left, right) =>
    `${left.name}\0${left.githubAdvisoryId}`.localeCompare(
      `${right.name}\0${right.githubAdvisoryId}`,
    ),
  );
}

async function readBoundedResponse(response) {
  if (!response.ok || !response.body) {
    throw new Error(
      `npm embedded-component audit failed with status ${response.status}`,
    );
  }
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!Number.isSafeInteger(Number(declaredLength)) ||
      Number(declaredLength) < 0 ||
      Number(declaredLength) > MAX_EMBEDDED_AUDIT_OUTPUT_BYTES)
  ) {
    throw new Error(
      "npm embedded-component audit response exceeded its byte budget",
    );
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > MAX_EMBEDDED_AUDIT_OUTPUT_BYTES) {
      throw new Error(
        "npm embedded-component audit response exceeded its byte budget",
      );
    }
    chunks.push(Buffer.from(chunk));
  }
  try {
    return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
  } catch {
    throw new Error("npm embedded-component audit returned invalid JSON");
  }
}

async function auditEmbeddedComponents(components) {
  const request = Object.fromEntries(
    [...components]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, version]) => [name, [version]]),
  );
  const response = await fetch(EMBEDDED_AUDIT_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
  });
  return findEmbeddedComponentAdvisories(
    await readBoundedResponse(response),
    components,
  );
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
  Promise.resolve()
    .then(async () => {
      const components = loadMcpBundleComponents(rootDir);
      const runtime = verifyInstalledClaudeSdkRuntime(rootDir);
      const [report, embeddedAdvisories] = await Promise.all([
        auditWorkspace(rootDir),
        auditEmbeddedComponents(runtime.embeddedComponents),
      ]);
      const advisories = findMcpBundleAdvisories(report, components);
      for (const [name, version] of runtime.embeddedComponents) {
        const existing = components.get(name);
        if (existing !== undefined && existing !== version) {
          throw new Error(
            `MCP component ${name} differs between the bundle and Claude runtime`,
          );
        }
        components.set(name, version);
      }
      const { active, mitigated } = partitionMitigatedAdvisories(
        [...advisories, ...embeddedAdvisories],
        runtime.mitigations,
      );
      if (mitigated.length !== runtime.mitigations.size) {
        throw new Error(
          "MCP embedded-component audit did not return every reviewed advisory",
        );
      }
      if (active.length > 0) {
        throw new Error(
          `MCP bundled dependencies have active advisories: ${active
            .map(
              ({ name, version, severity }) =>
                `${name}@${version} (${severity})`,
            )
            .join(", ")}`,
        );
      }
      console.log(
        `Audited ${components.size} MCP distributed dependency versions; ` +
          `${mitigated.length} advisory matched an exact runtime mitigation.`,
      );
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
