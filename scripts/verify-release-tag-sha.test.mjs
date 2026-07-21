import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  formatReleaseTagVerificationError,
  parseCliArguments,
  verifyReleaseTagSha,
} from "./verify-release-tag-sha.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT_PATH = join(REPOSITORY_ROOT, "scripts/verify-release-tag-sha.mjs");
const RELEASE_TAG = "v1.2.3";
const TEMP_REF_NAMESPACE = "refs/webpage-mcp/release-verification/";
const FETCH_HEAD_SENTINEL = "release-tag-fetch-head-sentinel\n";

function runGit(cwd, args, { input } = {}) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "Never",
    },
    input,
    maxBuffer: 1024 * 1024,
    timeout: 10_000,
    windowsHide: true,
  });
  assert.equal(
    result.error,
    undefined,
    `Git fixture command ${args[0]} could not start; output withheld.`,
  );
  assert.equal(
    result.status,
    0,
    `Git fixture command ${args[0]} failed with status ${String(result.status)}; output withheld.`,
  );
  return result.stdout.trim();
}

async function createRepository(t) {
  const root = await mkdtemp(join(tmpdir(), "webpage-mcp-release-tag-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const remote = join(root, "origin.git");
  const repository = join(root, "checkout");
  runGit(root, ["init", "--bare", "--initial-branch=main", remote]);
  runGit(root, ["init", "--initial-branch=main", repository]);
  runGit(repository, ["config", "user.name", "Release Test"]);
  runGit(repository, ["config", "user.email", "release-test@example.invalid"]);
  await writeFile(join(repository, "fixture.txt"), "first\n");
  runGit(repository, ["add", "--", "fixture.txt"]);
  runGit(repository, ["commit", "-m", "first"]);
  const firstCommit = runGit(repository, ["rev-parse", "HEAD"]);
  runGit(repository, ["remote", "add", "origin", remote]);
  runGit(repository, ["push", "origin", "HEAD:refs/heads/main"]);
  await writeFile(join(repository, ".git", "FETCH_HEAD"), FETCH_HEAD_SENTINEL);
  return { root, remote, repository, firstCommit };
}

async function createSecondCommit(repository) {
  await writeFile(join(repository, "fixture.txt"), "second\n");
  runGit(repository, ["add", "--", "fixture.txt"]);
  runGit(repository, ["commit", "-m", "second"]);
  return runGit(repository, ["rev-parse", "HEAD"]);
}

function pushLightweightTag(repository, commit = "HEAD") {
  runGit(repository, ["tag", RELEASE_TAG, commit]);
  runGit(repository, [
    "push",
    "origin",
    `refs/tags/${RELEASE_TAG}:refs/tags/${RELEASE_TAG}`,
  ]);
}

function temporaryVerificationRefs(repository) {
  return runGit(repository, [
    "for-each-ref",
    "--format=%(refname)",
    TEMP_REF_NAMESPACE,
  ]);
}

async function assertVerificationStateUnchanged(repository) {
  assert.equal(temporaryVerificationRefs(repository), "");
  assert.equal(
    await readFile(join(repository, ".git", "FETCH_HEAD"), "utf8"),
    FETCH_HEAD_SENTINEL,
  );
}

async function rejectionError(action) {
  let caught;
  try {
    await action();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Error, "Expected verification to reject");
  return caught;
}

async function rejectionMessage(action) {
  return (await rejectionError(action)).message;
}

test("verifies a lightweight remote tag without changing FETCH_HEAD", async (t) => {
  const { repository, firstCommit } = await createRepository(t);
  pushLightweightTag(repository, firstCommit);

  assert.deepEqual(
    await verifyReleaseTagSha({
      cwd: repository,
      tag: RELEASE_TAG,
      expectedSha: firstCommit,
    }),
    { tag: RELEASE_TAG, expectedSha: firstCommit },
  );
  await assertVerificationStateUnchanged(repository);
});

test("peels an annotated remote tag to its commit", async (t) => {
  const { repository, firstCommit } = await createRepository(t);
  runGit(repository, [
    "tag",
    "--annotate",
    RELEASE_TAG,
    "--message",
    "release",
    firstCommit,
  ]);
  runGit(repository, [
    "push",
    "origin",
    `refs/tags/${RELEASE_TAG}:refs/tags/${RELEASE_TAG}`,
  ]);

  await verifyReleaseTagSha({
    cwd: repository,
    tag: RELEASE_TAG,
    expectedSha: firstCommit,
  });
  await assertVerificationStateUnchanged(repository);
});

test("accepts an older release commit that remains in remote main", async (t) => {
  const { repository, firstCommit } = await createRepository(t);
  pushLightweightTag(repository, firstCommit);
  await createSecondCommit(repository);
  runGit(repository, ["push", "origin", "HEAD:refs/heads/main"]);

  await verifyReleaseTagSha({
    cwd: repository,
    tag: RELEASE_TAG,
    expectedSha: firstCommit,
  });
  await assertVerificationStateUnchanged(repository);
});

test("rejects a reviewed tag commit that was never merged into remote main", async (t) => {
  const { repository } = await createRepository(t);
  const unmergedCommit = await createSecondCommit(repository);
  pushLightweightTag(repository, unmergedCommit);

  const message = await rejectionMessage(() =>
    verifyReleaseTagSha({
      cwd: repository,
      tag: RELEASE_TAG,
      expectedSha: unmergedCommit,
    }),
  );
  assert.match(message, /not contained in the remote main branch/);
  await assertVerificationStateUnchanged(repository);
});

test("rejects a remotely moved tag even when the stale local tag still matches", async (t) => {
  const { repository, firstCommit } = await createRepository(t);
  pushLightweightTag(repository, firstCommit);
  const secondCommit = await createSecondCommit(repository);
  runGit(repository, [
    "push",
    "--force",
    "origin",
    `${secondCommit}:refs/tags/${RELEASE_TAG}`,
  ]);
  assert.equal(
    runGit(repository, ["rev-parse", `refs/tags/${RELEASE_TAG}`]),
    firstCommit,
  );

  const message = await rejectionMessage(() =>
    verifyReleaseTagSha({
      cwd: repository,
      tag: RELEASE_TAG,
      expectedSha: firstCommit,
    }),
  );
  assert.match(message, /does not point at the expected gated commit/);
  await assertVerificationStateUnchanged(repository);
});

test("rejects a remotely deleted tag and cleans the temporary namespace", async (t) => {
  const { repository, firstCommit } = await createRepository(t);
  pushLightweightTag(repository, firstCommit);
  runGit(repository, ["push", "origin", `:refs/tags/${RELEASE_TAG}`]);

  const message = await rejectionMessage(() =>
    verifyReleaseTagSha({
      cwd: repository,
      tag: RELEASE_TAG,
      expectedSha: firstCommit,
    }),
  );
  assert.match(message, /Remote release tag fetch failed/);
  assert.match(message, /contents withheld/);
  await assertVerificationStateUnchanged(repository);
});

test("rejects a remote tag that cannot be peeled to a commit", async (t) => {
  const { repository, firstCommit } = await createRepository(t);
  const blob = runGit(repository, ["rev-parse", `${firstCommit}:fixture.txt`]);
  runGit(repository, ["tag", RELEASE_TAG, blob]);
  runGit(repository, [
    "push",
    "origin",
    `refs/tags/${RELEASE_TAG}:refs/tags/${RELEASE_TAG}`,
  ]);

  const message = await rejectionMessage(() =>
    verifyReleaseTagSha({
      cwd: repository,
      tag: RELEASE_TAG,
      expectedSha: firstCommit,
    }),
  );
  assert.match(message, /Release tag commit peel failed/);
  assert.match(message, /contents withheld/);
  await assertVerificationStateUnchanged(repository);
});

test("rejects malformed tags and expected SHAs before fetching", async (t) => {
  const { repository, firstCommit } = await createRepository(t);
  for (const tag of [
    "",
    "1.2.3",
    "refs/tags/v1.2.3",
    "--upload-pack=malicious",
    "v1.2",
    "v01.2.3",
    "v1.2.3-beta.1",
    "v1.2.3+build.1",
    "v0.0.0",
    "v65536.1.1",
    "v1.2.3:refs/heads/main",
  ]) {
    await assert.rejects(
      verifyReleaseTagSha({
        cwd: repository,
        tag,
        expectedSha: firstCommit,
      }),
      /Release tag must be/,
    );
  }
  for (const expectedSha of [
    "a".repeat(39),
    "a".repeat(41),
    "g".repeat(40),
    "A".repeat(40),
  ]) {
    await assert.rejects(
      verifyReleaseTagSha({
        cwd: repository,
        tag: RELEASE_TAG,
        expectedSha,
      }),
      /exactly 40 lowercase hexadecimal/,
    );
  }
  await assertVerificationStateUnchanged(repository);
});

test("withholds Git stderr contents when the remote fetch fails", async (t) => {
  const { root, repository, firstCommit } = await createRepository(t);
  const secretMarker = "release-tag-remote-secret-marker";
  runGit(repository, ["remote", "set-url", "origin", join(root, secretMarker)]);

  const message = await rejectionMessage(() =>
    verifyReleaseTagSha({
      cwd: repository,
      tag: RELEASE_TAG,
      expectedSha: firstCommit,
    }),
  );
  assert.doesNotMatch(message, new RegExp(secretMarker));
  assert.match(
    message,
    /Remote release tag fetch failed \(code=\d+, signal=none, stdoutBytes=\d+, stderrBytes=\d+; contents withheld\)/,
  );
  await assertVerificationStateUnchanged(repository);
});

test("withholds unexpected internal errors from API and CLI diagnostics", async (t) => {
  const { repository, firstCommit } = await createRepository(t);
  const secretMarker = "release-tag-unexpected-secret-marker";
  const environment = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error(secretMarker);
      },
    },
  );
  const message = await rejectionMessage(() =>
    verifyReleaseTagSha({
      cwd: repository,
      environment,
      tag: RELEASE_TAG,
      expectedSha: firstCommit,
    }),
  );
  assert.doesNotMatch(message, new RegExp(secretMarker));
  assert.match(message, /contents withheld/);
  assert.equal(
    formatReleaseTagVerificationError(new Error(secretMarker)),
    "Release tag verification failed unexpectedly; contents withheld.",
  );
  await assertVerificationStateUnchanged(repository);
});

test("fails closed and withholds both errors when temporary ref cleanup fails", async (t) => {
  const { repository, firstCommit } = await createRepository(t);
  pushLightweightTag(repository, firstCommit);
  const hookSecret = "release-tag-cleanup-hook-secret-marker";
  const hookPath = join(repository, ".git", "hooks", "reference-transaction");
  await writeFile(
    hookPath,
    `#!/usr/bin/env node
const { readFileSync } = require("node:fs");
const phase = process.argv[2];
const input = readFileSync(0, "utf8");
const rejectsCleanup = input
  .trim()
  .split(/\\r?\\n/)
  .some((line) => {
    const fields = line.split(" ");
    return /^0{40}$/.test(fields[1] || "") &&
      (fields[2] || "").startsWith(${JSON.stringify(TEMP_REF_NAMESPACE)});
  });
if (phase === "prepared" && rejectsCleanup) {
  process.stderr.write(${JSON.stringify(`${hookSecret}\n`)});
  process.exit(1);
}
`,
  );
  await chmod(hookPath, 0o755);
  const mismatchedSha = `${firstCommit[0] === "0" ? "1" : "0"}${firstCommit.slice(1)}`;

  const error = await rejectionError(() =>
    verifyReleaseTagSha({
      cwd: repository,
      tag: RELEASE_TAG,
      expectedSha: mismatchedSha,
    }),
  );
  assert.equal(
    error.message,
    "Release tag verification and temporary ref cleanup both failed; details withheld.",
  );
  assert.equal(error.cause, undefined);
  assert.doesNotMatch(
    error.message,
    /does not point at the expected gated commit/,
  );
  assert.doesNotMatch(error.message, new RegExp(hookSecret));

  const remainingRefs = temporaryVerificationRefs(repository)
    .split(/\r?\n/)
    .filter(Boolean);
  assert.equal(remainingRefs.length, 2);
  await rm(hookPath, { force: true });
  for (const ref of remainingRefs) {
    runGit(repository, ["update-ref", "-d", ref]);
  }
  await assertVerificationStateUnchanged(repository);
});

test("CLI accepts only one complete strict argument pair", async (t) => {
  const { repository, firstCommit } = await createRepository(t);
  pushLightweightTag(repository, firstCommit);
  const success = spawnSync(
    process.execPath,
    [SCRIPT_PATH, "--tag", RELEASE_TAG, "--expected-sha", firstCommit],
    { cwd: repository, encoding: "utf8", windowsHide: true },
  );
  assert.equal(success.status, 0, success.stderr);
  assert.match(success.stdout, /Remote release tag commit verified/);

  for (const args of [
    ["--tag", RELEASE_TAG],
    ["--expected-sha", firstCommit],
    ["--tag", RELEASE_TAG, "--tag", RELEASE_TAG, "--expected-sha", firstCommit],
    [
      "--tag",
      RELEASE_TAG,
      "--expected-sha",
      firstCommit,
      "--unknown",
      "cli-secret-marker",
    ],
  ]) {
    const failure = spawnSync(process.execPath, [SCRIPT_PATH, ...args], {
      cwd: repository,
      encoding: "utf8",
      windowsHide: true,
    });
    assert.notEqual(failure.status, 0);
    assert.doesNotMatch(
      `${failure.stdout}\n${failure.stderr}`,
      /cli-secret-marker/,
    );
  }
  await assertVerificationStateUnchanged(repository);
});

test("CLI parser rejects duplicate, missing, and unsafe values", () => {
  assert.deepEqual(
    parseCliArguments(["--expected-sha", "a".repeat(40), "--tag", RELEASE_TAG]),
    { tag: RELEASE_TAG, expectedSha: "a".repeat(40) },
  );
  assert.throws(() => parseCliArguments([]), /--tag is required/);
  assert.throws(
    () =>
      parseCliArguments([
        "--tag",
        RELEASE_TAG,
        "--tag",
        RELEASE_TAG,
        "--expected-sha",
        "a".repeat(40),
      ]),
    /--tag may be provided only once/,
  );
  assert.throws(
    () => parseCliArguments(["--unknown", "secret"]),
    /Unexpected release tag verification argument/,
  );
});

test("implementation uses an isolated bounded fetch and fail-closed cleanup", async () => {
  const source = await readFile(SCRIPT_PATH, "utf8");
  assert.match(
    source,
    /"fetch",\s*"--no-tags",\s*"--force",\s*"--no-write-fetch-head",\s*"origin",\s*`\$\{sourceRef\}:\$\{temporaryTagRef\}`,\s*`\$\{RELEASE_BRANCH_REF\}:\$\{temporaryBranchRef\}`/,
  );
  assert.match(source, /"merge-base",\s*"--is-ancestor"/);
  assert.match(source, /GIT_TERMINAL_PROMPT: "0"/);
  assert.match(source, /LC_ALL: "C"/);
  assert.match(source, /maxBuffer: MAX_GIT_OUTPUT_BYTES/);
  assert.match(source, /timeout: GIT_TIMEOUT_MS/);
  assert.match(source, /"update-ref", "-d", temporaryRef/);
  assert.match(
    source,
    /if \(cleanupError\) \{\s*throw new ReleaseTagVerificationError/,
  );
  assert.doesNotMatch(source, /stderr\.(?:toString|subarray)/);
});
