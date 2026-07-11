import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { Readable } from "node:stream";
import test from "node:test";
import { URL } from "node:url";

import {
  CARGO_DENY_TOOL,
  assertSupportedPlatform,
  downloadVerifiedArchive,
  extractVerifiedBinary,
  formatInstallerError,
  probeCargoDeny,
  verifyCachedBinary,
} from "./install-cargo-deny.mjs";

const INSTALLER_URL = new URL("./install-cargo-deny.mjs", import.meta.url);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function temporaryDirectory(t, prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(directory, { force: true, recursive: true }));
  return directory;
}

function fixtureArchive(bytes) {
  return {
    url: CARGO_DENY_TOOL.archive.url,
    size: bytes.length,
    sha256: sha256(bytes),
  };
}

function fixtureBinary(entry, bytes, versionOutput = "cargo-deny 0.0.0") {
  return {
    entry,
    filename: "cargo-deny",
    size: bytes.length,
    sha256: sha256(bytes),
    versionOutput,
    mode: "0755",
  };
}

test("cargo-deny tool pin is exact, immutable, and not environment-configurable", async () => {
  assert.deepEqual(CARGO_DENY_TOOL, {
    schemaVersion: 1,
    name: "cargo-deny",
    version: "0.19.8",
    platform: "linux",
    arch: "x64",
    rustToolchain: "1.94.0",
    archive: {
      url: "https://github.com/EmbarkStudios/cargo-deny/releases/download/0.19.8/cargo-deny-0.19.8-x86_64-unknown-linux-musl.tar.gz",
      size: 4_983_961,
      sha256:
        "70e769ae3872e34d45132b17040859175e11401dc12dddb0303e0b8c7d088f3f",
    },
    binary: {
      entry: "cargo-deny-0.19.8-x86_64-unknown-linux-musl/cargo-deny",
      filename: "cargo-deny",
      size: 8_951_120,
      sha256:
        "f84bbd8f18ca59d531b848bad2f39237b17b5980d7f9cdd373d81f6689eb685f",
      versionOutput: "cargo-deny 0.19.8",
      mode: "0755",
    },
  });
  assert.ok(Object.isFrozen(CARGO_DENY_TOOL));
  assert.ok(Object.isFrozen(CARGO_DENY_TOOL.archive));
  assert.ok(Object.isFrozen(CARGO_DENY_TOOL.binary));
  assert.throws(() => {
    CARGO_DENY_TOOL.version = "99.0.0";
  }, TypeError);

  const source = await readFile(INSTALLER_URL, "utf8");
  assert.doesNotMatch(
    source,
    /process\.env/,
    "tool identity, hashes, limits, and URLs must not come from the environment",
  );
});

test("platform gate accepts only the pinned Linux x64 target", () => {
  assert.doesNotThrow(() => assertSupportedPlatform("linux", "x64"));
  assert.throws(
    () => assertSupportedPlatform("darwin", "x64"),
    /unsupported platform darwin\/x64/,
  );
  assert.throws(
    () => assertSupportedPlatform("linux", "arm64"),
    /unsupported platform linux\/arm64/,
  );
});

test("CLI diagnostics preserve reviewed failures and withhold native details", () => {
  const marker = "signed-url-secret-marker";
  assert.equal(
    formatInstallerError(
      new Error(`fetch failed at https://example.test/?sig=${marker}`),
    ),
    "[install-cargo-deny] installation failed; details withheld",
  );
  assert.doesNotMatch(
    formatInstallerError(new Error(marker)),
    new RegExp(marker),
  );
  let reviewedError;
  try {
    assertSupportedPlatform("darwin", "arm64");
  } catch (error) {
    reviewedError = error;
  }
  assert.match(formatInstallerError(reviewedError), /unsupported platform/);
});

test("download follows only the fixed GitHub release redirect and verifies bytes", async (t) => {
  const directory = await temporaryDirectory(t, "cargo-deny-download-");
  const destination = join(directory, "archive.tar.gz");
  const bytes = Buffer.from("small synthetic cargo-deny archive");
  const requests = [];
  const responses = [
    new globalThis.Response(null, {
      status: 302,
      headers: {
        location:
          "https://release-assets.githubusercontent.com/fixed-reviewed-asset?signature=synthetic",
      },
    }),
    new globalThis.Response(bytes, {
      status: 200,
      headers: { "content-length": String(bytes.length) },
    }),
  ];

  await downloadVerifiedArchive(fixtureArchive(bytes), destination, {
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      return responses.shift();
    },
  });

  assert.deepEqual(await readFile(destination), bytes);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].options.redirect, "manual");
  assert.equal(requests[0].options.headers["Accept-Encoding"], "identity");
  assert.equal(
    requests[1].url,
    "https://release-assets.githubusercontent.com/fixed-reviewed-asset?signature=synthetic",
  );
});

test("download rejects insecure and unreviewed redirect targets", async (t) => {
  const directory = await temporaryDirectory(t, "cargo-deny-redirect-");
  const archive = fixtureArchive(Buffer.from("fixture"));
  for (const [name, location, expected] of [
    [
      "plaintext",
      "http://release-assets.githubusercontent.com/asset",
      /fixed HTTPS download policy/,
    ],
    [
      "foreign host",
      "https://example.com/asset",
      /fixed HTTPS download policy/,
    ],
    [
      "GitHub non-asset",
      "https://github.com/another/path",
      /did not target GitHub release assets/,
    ],
  ]) {
    const destination = join(directory, `${name}.tgz`);
    let requestCount = 0;
    await assert.rejects(
      downloadVerifiedArchive(archive, destination, {
        fetchImpl: async () => {
          requestCount += 1;
          return new globalThis.Response(null, {
            status: 302,
            headers: { location },
          });
        },
      }),
      expected,
    );
    assert.equal(requestCount, 1);
  }
});

test("download enforces declared length, streamed bounds, digest, and idle timeout", async (t) => {
  const directory = await temporaryDirectory(t, "cargo-deny-bounds-");
  const bytes = Buffer.from("verified");
  const archive = fixtureArchive(bytes);

  await assert.rejects(
    downloadVerifiedArchive(archive, join(directory, "length.tgz"), {
      fetchImpl: async () =>
        new globalThis.Response(bytes, {
          status: 200,
          headers: { "content-length": String(bytes.length + 1) },
        }),
    }),
    /Content-Length does not match/,
  );

  await assert.rejects(
    downloadVerifiedArchive(archive, join(directory, "oversize.tgz"), {
      fetchImpl: async () =>
        new globalThis.Response(Buffer.concat([bytes, Buffer.from("!")]), {
          status: 200,
        }),
    }),
    /exceeded its pinned size/,
  );

  await assert.rejects(
    downloadVerifiedArchive(
      { ...archive, sha256: "0".repeat(64) },
      join(directory, "digest.tgz"),
      {
        fetchImpl: async () => new globalThis.Response(bytes, { status: 200 }),
      },
    ),
    /SHA-256 does not match/,
  );

  await assert.rejects(
    downloadVerifiedArchive(archive, join(directory, "idle.tgz"), {
      fetchImpl: async () =>
        new globalThis.Response(
          new globalThis.ReadableStream({
            start() {},
          }),
          { status: 200 },
        ),
      idleTimeoutMs: 5,
      timeoutMs: 100,
    }),
    /timed out or exceeded its bounds/,
  );
});

test("extraction invokes fixed tar with an exact entry and writes verified bytes", async (t) => {
  const directory = await temporaryDirectory(t, "cargo-deny-extract-mock-");
  const archive = join(directory, "fixture.tar.gz");
  const destination = join(directory, "extracted-cargo-deny");
  const entry = "cargo-deny-fixture/cargo-deny";
  const bytes = Buffer.from("synthetic executable bytes");
  await writeFile(archive, Buffer.from("synthetic archive placeholder"));
  let invocation;
  const spawnImpl = (command, args, options) => {
    invocation = { command, args, options };
    const child = new EventEmitter();
    child.stdout = Readable.from([bytes]);
    child.stderr = Readable.from([]);
    child.kill = () => false;
    globalThis.queueMicrotask(() => child.emit("close", 0, null));
    return child;
  };

  await extractVerifiedBinary(
    archive,
    fixtureBinary(entry, bytes),
    destination,
    { spawnImpl },
  );
  assert.deepEqual(await readFile(destination), bytes);
  assert.equal(invocation.command, "/usr/bin/tar");
  assert.deepEqual(invocation.args, ["-xOzf", archive, "--", entry]);
  assert.equal(invocation.options.shell, false);
  assert.deepEqual(invocation.options.stdio, ["ignore", "pipe", "pipe"]);
  assert.deepEqual(invocation.options.env, {
    HOME: "/tmp",
    LANG: "C",
    LC_ALL: "C",
    PATH: "/usr/bin:/bin",
  });
});

test(
  "Linux tar integration extracts the exact synthetic entry with mode 0755",
  { skip: process.platform !== "linux" },
  async (t) => {
    const directory = await temporaryDirectory(t, "cargo-deny-extract-");
    const source = join(directory, "source");
    const entryDirectory = join(source, "cargo-deny-fixture");
    const entry = "cargo-deny-fixture/cargo-deny";
    const bytes = Buffer.from("#!/bin/sh\nprintf 'cargo-deny 0.0.0\\n'\n");
    await mkdir(entryDirectory, { recursive: true });
    await writeFile(join(entryDirectory, "cargo-deny"), bytes, { mode: 0o755 });
    const archive = join(directory, "fixture.tar.gz");
    const tarResult = spawnSync(
      "/usr/bin/tar",
      ["-czf", archive, "-C", source, entry],
      { encoding: "utf8" },
    );
    assert.equal(tarResult.status, 0, tarResult.stderr);

    const destination = join(directory, "extracted-cargo-deny");
    const binary = fixtureBinary(entry, bytes);
    await extractVerifiedBinary(archive, binary, destination);
    assert.deepEqual(await readFile(destination), bytes);
    assert.equal(await verifyCachedBinary(destination, binary), true);
  },
);

test("spawn failures close the staged file, clear work, and withhold native details", async (t) => {
  const directory = await temporaryDirectory(t, "cargo-deny-spawn-error-");
  const archive = join(directory, "fixture.tar.gz");
  const destination = join(directory, "extracted-cargo-deny");
  const bytes = Buffer.from("synthetic executable bytes");
  const marker = "native-spawn-secret-marker";
  await writeFile(archive, Buffer.from("synthetic archive placeholder"));
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stdout = Readable.from([]);
    child.stderr = Readable.from([]);
    child.kill = () => false;
    globalThis.queueMicrotask(() => child.emit("error", new Error(marker)));
    return child;
  };

  let caught;
  try {
    await extractVerifiedBinary(
      archive,
      fixtureBinary("fixture/cargo-deny", bytes),
      destination,
      { spawnImpl },
    );
  } catch (error) {
    caught = error;
  }
  assert.ok(caught);
  const diagnostic = formatInstallerError(caught);
  assert.equal(
    diagnostic,
    "[install-cargo-deny] installation failed; details withheld",
  );
  assert.doesNotMatch(diagnostic, new RegExp(marker));
  await rm(destination);
});

test(
  "cache verification rejects links, corruption, and privileged mode bits",
  { skip: process.platform === "win32" },
  async (t) => {
    const directory = await temporaryDirectory(t, "cargo-deny-cache-");
    const bytes = Buffer.from("synthetic executable");
    const binary = fixtureBinary("fixture/cargo-deny", bytes);
    const regular = join(directory, "regular");
    await writeFile(regular, bytes, { mode: 0o600 });
    assert.equal(await verifyCachedBinary(regular, binary), false);
    await chmod(regular, 0o755);
    assert.equal(await verifyCachedBinary(regular, binary), true);
    await chmod(regular, 0o4755);
    assert.equal(await verifyCachedBinary(regular, binary), false);
    await chmod(regular, 0o755);
    await writeFile(regular, Buffer.from("corrupt"), { mode: 0o755 });
    assert.equal(await verifyCachedBinary(regular, binary), false);

    const link = join(directory, "cargo-deny");
    await symlink(regular, link);
    await assert.rejects(
      verifyCachedBinary(link, binary),
      /must not be a symlink/,
    );
  },
);

test("version probe executes only an absolute binary path and checks exact output", async (t) => {
  const directory = await temporaryDirectory(t, "cargo-deny-probe-");
  const executable = join(directory, "cargo-deny");
  const bytes = Buffer.from("synthetic executable bytes");
  const binary = fixtureBinary("fixture/cargo-deny", bytes);
  let invocation;
  const spawnSyncImpl = (command, args, options) => {
    invocation = { command, args, options };
    return {
      error: undefined,
      signal: null,
      status: 0,
      stdout: "cargo-deny 0.0.0\n",
      stderr: "",
    };
  };
  assert.doesNotThrow(() =>
    probeCargoDeny(executable, binary, { spawnSyncImpl }),
  );
  assert.equal(invocation.command, executable);
  assert.deepEqual(invocation.args, ["--version"]);
  assert.equal(invocation.options.shell, false);
  assert.throws(
    () => probeCargoDeny("cargo-deny", binary, { spawnSyncImpl }),
    /bounded absolute path without controls/,
  );
  assert.throws(
    () =>
      probeCargoDeny(
        executable,
        { ...binary, versionOutput: "wrong" },
        {
          spawnSyncImpl,
        },
      ),
    /version probe failed/,
  );
});

test("filesystem paths reject controls and excessive length before I/O", async () => {
  const bytes = Buffer.from("fixture");
  const archive = fixtureArchive(bytes);
  await assert.rejects(
    downloadVerifiedArchive(archive, "/tmp/cargo-deny\narchive", {
      fetchImpl: async () => new globalThis.Response(bytes, { status: 200 }),
    }),
    /without controls/,
  );
  assert.throws(
    () =>
      probeCargoDeny(
        `/tmp/${"a".repeat(5000)}`,
        fixtureBinary("fixture", bytes),
        {
          spawnSyncImpl: () => assert.fail("must not spawn"),
        },
      ),
    /bounded absolute path/,
  );
});
