#!/usr/bin/env node

import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import console from "node:console";
import { randomUUID, timingSafeEqual } from "node:crypto";
import process from "node:process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { validateUnifiedReleaseVersion } from "./unified-release-version.mjs";

const EXPECTED_SHA_PATTERN = /^[0-9a-f]{40}$/;
const RELEASE_TAG_PATTERN = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const RELEASE_BRANCH_REF = "refs/heads/main";
const TEMP_REF_PREFIX = "refs/webpage-mcp/release-verification";
const MAX_TEMP_REF_ATTEMPTS = 8;
const MAX_GIT_OUTPUT_BYTES = 64 * 1024;
const GIT_TIMEOUT_MS = 30_000;

class ReleaseTagVerificationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReleaseTagVerificationError";
  }
}

function invariant(condition, message) {
  if (!condition) throw new ReleaseTagVerificationError(message);
}

function asPublicError(error, fallback) {
  return error instanceof ReleaseTagVerificationError
    ? error
    : new ReleaseTagVerificationError(fallback);
}

function outputBytes(value) {
  if (Buffer.isBuffer(value)) return value.length;
  return typeof value === "string" ? Buffer.byteLength(value) : 0;
}

function safeProcessValue(value, fallback) {
  if (value === null || value === undefined) return fallback;
  const normalized = String(value);
  return /^(?:-?\d+|[A-Z][A-Z0-9_]*)$/.test(normalized) ? normalized : fallback;
}

function gitFailure(stage, error, stdout, stderr) {
  const code = safeProcessValue(error?.code, "unknown");
  const signal = safeProcessValue(error?.signal, "none");
  return new ReleaseTagVerificationError(
    `${stage} failed (code=${code}, signal=${signal}, stdoutBytes=${outputBytes(stdout)}, stderrBytes=${outputBytes(stderr)}; contents withheld)`,
  );
}

function runGit({ cwd, environment, stage, args, allowedExitCodes = [0] }) {
  return new Promise((resolvePromise, reject) => {
    try {
      execFile(
        "git",
        args,
        {
          cwd,
          encoding: "buffer",
          env: {
            ...environment,
            GIT_TERMINAL_PROMPT: "0",
            GCM_INTERACTIVE: "Never",
            LC_ALL: "C",
          },
          maxBuffer: MAX_GIT_OUTPUT_BYTES,
          timeout: GIT_TIMEOUT_MS,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          try {
            const exitCode = error ? error.code : 0;
            if (
              !error ||
              (typeof exitCode === "number" &&
                allowedExitCodes.includes(exitCode))
            ) {
              resolvePromise({
                exitCode,
                stdout: Buffer.isBuffer(stdout)
                  ? stdout
                  : Buffer.from(stdout ?? ""),
              });
              return;
            }
            reject(gitFailure(stage, error, stdout, stderr));
          } catch {
            reject(
              new ReleaseTagVerificationError(
                `${stage} failed unexpectedly; contents withheld.`,
              ),
            );
          }
        },
      );
    } catch {
      reject(
        new ReleaseTagVerificationError(
          `${stage} failed before launch; contents withheld.`,
        ),
      );
    }
  });
}

function validateReleaseTag(tag) {
  invariant(
    typeof tag === "string" &&
      tag.length <= 32 &&
      RELEASE_TAG_PATTERN.test(tag),
    "Release tag must be a canonical stable vX.Y.Z tag.",
  );
  try {
    validateUnifiedReleaseVersion(tag.slice(1), "Release tag version");
  } catch {
    throw new ReleaseTagVerificationError(
      "Release tag must be a non-zero Chrome-compatible stable vX.Y.Z tag.",
    );
  }
  return tag;
}

function validateExpectedSha(expectedSha) {
  invariant(
    typeof expectedSha === "string" && EXPECTED_SHA_PATTERN.test(expectedSha),
    "Expected release SHA must be exactly 40 lowercase hexadecimal characters.",
  );
  return expectedSha;
}

async function allocateTemporaryRef({ cwd, environment }) {
  for (let attempt = 0; attempt < MAX_TEMP_REF_ATTEMPTS; attempt += 1) {
    const temporaryRef = `${TEMP_REF_PREFIX}/${process.pid}-${randomUUID()}`;
    const result = await runGit({
      cwd,
      environment,
      stage: "Temporary release ref collision check",
      args: ["show-ref", "--verify", "--quiet", temporaryRef],
      allowedExitCodes: [0, 1],
    });
    if (result.exitCode === 1) return temporaryRef;
  }
  throw new ReleaseTagVerificationError(
    "Unable to allocate a unique temporary release ref.",
  );
}

async function removeTemporaryRef({ cwd, environment, temporaryRef }) {
  await runGit({
    cwd,
    environment,
    stage: "Temporary release ref cleanup",
    args: ["update-ref", "-d", temporaryRef],
  });
  const result = await runGit({
    cwd,
    environment,
    stage: "Temporary release ref cleanup verification",
    args: ["show-ref", "--verify", "--quiet", temporaryRef],
    allowedExitCodes: [0, 1],
  });
  invariant(
    result.exitCode === 1,
    "Temporary release ref cleanup verification failed; ref still exists.",
  );
}

function parsePeeledCommit(stdout) {
  const match = /^([0-9a-f]{40})(?:\r?\n)?$/.exec(stdout.toString("ascii"));
  invariant(
    match !== null,
    "Git returned an invalid peeled release commit; contents withheld.",
  );
  return match[1];
}

async function verifyReleaseTagShaInternal({
  cwd = process.cwd(),
  environment = process.env,
  tag,
  expectedSha,
} = {}) {
  const validatedTag = validateReleaseTag(tag);
  const validatedExpectedSha = validateExpectedSha(expectedSha);
  const sourceRef = `refs/tags/${validatedTag}`;
  const temporaryTagRef = await allocateTemporaryRef({ cwd, environment });
  const temporaryBranchRef = await allocateTemporaryRef({ cwd, environment });
  let verificationError;

  try {
    await runGit({
      cwd,
      environment,
      stage: "Remote release tag fetch",
      args: [
        "fetch",
        "--no-tags",
        "--force",
        "--no-write-fetch-head",
        "origin",
        `${sourceRef}:${temporaryTagRef}`,
        `${RELEASE_BRANCH_REF}:${temporaryBranchRef}`,
      ],
    });
    const peeled = await runGit({
      cwd,
      environment,
      stage: "Release tag commit peel",
      args: [
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${temporaryTagRef}^{commit}`,
      ],
    });
    const actualSha = parsePeeledCommit(peeled.stdout);
    invariant(
      timingSafeEqual(
        Buffer.from(actualSha, "ascii"),
        Buffer.from(validatedExpectedSha, "ascii"),
      ),
      "Remote release tag does not point at the expected gated commit.",
    );
    const ancestry = await runGit({
      cwd,
      environment,
      stage: "Release commit ancestry check",
      args: ["merge-base", "--is-ancestor", actualSha, temporaryBranchRef],
      allowedExitCodes: [0, 1],
    });
    invariant(
      ancestry.exitCode === 0,
      "Release commit is not contained in the remote main branch.",
    );
  } catch (error) {
    verificationError = asPublicError(
      error,
      "Release tag verification failed unexpectedly; contents withheld.",
    );
  }

  let cleanupError;
  for (const temporaryRef of [temporaryTagRef, temporaryBranchRef]) {
    try {
      await removeTemporaryRef({ cwd, environment, temporaryRef });
    } catch (error) {
      cleanupError ??= asPublicError(
        error,
        "Temporary release ref cleanup failed unexpectedly; contents withheld.",
      );
    }
  }

  if (cleanupError) {
    throw new ReleaseTagVerificationError(
      verificationError
        ? "Release tag verification and temporary ref cleanup both failed; details withheld."
        : cleanupError.message,
    );
  }
  if (verificationError) throw verificationError;

  return { tag: validatedTag, expectedSha: validatedExpectedSha };
}

export async function verifyReleaseTagSha(options = {}) {
  try {
    return await verifyReleaseTagShaInternal(options);
  } catch (error) {
    throw asPublicError(
      error,
      "Release tag verification failed unexpectedly; contents withheld.",
    );
  }
}

export function parseCliArguments(argv) {
  let tag;
  let expectedSha;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--tag") {
      invariant(tag === undefined, "--tag may be provided only once.");
      invariant(index + 1 < argv.length, "--tag requires a value.");
      tag = argv[index + 1];
      index += 1;
      continue;
    }
    if (argument === "--expected-sha") {
      invariant(
        expectedSha === undefined,
        "--expected-sha may be provided only once.",
      );
      invariant(index + 1 < argv.length, "--expected-sha requires a value.");
      expectedSha = argv[index + 1];
      index += 1;
      continue;
    }
    throw new ReleaseTagVerificationError(
      "Unexpected release tag verification argument.",
    );
  }
  invariant(tag !== undefined, "--tag is required.");
  invariant(expectedSha !== undefined, "--expected-sha is required.");
  return {
    tag: validateReleaseTag(tag),
    expectedSha: validateExpectedSha(expectedSha),
  };
}

export function formatReleaseTagVerificationError(error) {
  return error instanceof ReleaseTagVerificationError
    ? error.message
    : "Release tag verification failed unexpectedly; contents withheld.";
}

async function main() {
  const { tag, expectedSha } = parseCliArguments(process.argv.slice(2));
  await verifyReleaseTagSha({ tag, expectedSha });
  console.log("Remote release tag commit verified.");
}

const isMain =
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  main().catch((error) => {
    console.error(
      `Release tag verification failed: ${formatReleaseTagVerificationError(error)}`,
    );
    process.exitCode = 1;
  });
}
