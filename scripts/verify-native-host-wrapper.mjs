#!/usr/bin/env node

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import console from "node:console";
import { randomUUID } from "node:crypto";
import {
  accessSync,
  constants as fsConstants,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST_DIR = resolve(
  process.env.WEBPAGE_MCP_NATIVE_WRAPPER_DIST_DIR ||
    resolve(REPOSITORY_ROOT, "app/mcp-server/dist"),
);
const MAX_OUTPUT_BYTES = 1024 * 1024;
const SMOKE_TIMEOUT_MS = 30_000;

function encodeNativeMessage(message) {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

function wrapperCommand(wrapperPath) {
  if (process.platform === "win32") {
    // /s strips one outer quote pair from the /c command string. Keep a second
    // pair around the batch path so cmd treats path metacharacters as data.
    return {
      command: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", `""${wrapperPath}""`],
    };
  }
  return { command: wrapperPath, args: [] };
}

function logDirectory(smokeRoot) {
  if (process.platform === "win32") {
    return join(smokeRoot, "local-app-data", "webpage-mcp", "logs");
  }
  if (process.platform === "darwin") {
    return join(smokeRoot, "home", "Library", "Logs", "webpage-mcp");
  }
  return join(smokeRoot, "xdg-state", "webpage-mcp", "logs");
}

function socketPath(smokeRoot) {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\webpage-mcp-release-smoke-${process.pid}-${randomUUID()}`;
  }
  return join(smokeRoot, "native.sock");
}

function decodeSingleNativeMessage(output) {
  assert.ok(Buffer.isBuffer(output), "Native wrapper stdout must be binary");
  assert.ok(output.length >= 4, "Native wrapper did not return a frame header");
  const payloadLength = output.readUInt32LE(0);
  assert.equal(
    output.length,
    payloadLength + 4,
    "Native wrapper must return exactly one complete frame",
  );
  return JSON.parse(output.subarray(4).toString("utf8"));
}

function verifyPongFrame(output) {
  let response;
  try {
    response = decodeSingleNativeMessage(output);
  } catch {
    throw new Error(
      "Native wrapper returned an invalid frame; contents withheld",
    );
  }
  assert.ok(
    response !== null &&
      typeof response === "object" &&
      !Array.isArray(response) &&
      Object.keys(response).length === 1 &&
      response.type === "pong_to_extension",
    "Native wrapper returned an unexpected frame; contents withheld",
  );
}

function stderrSummary(stderr) {
  const capturedBytes = Buffer.isBuffer(stderr) ? stderr.length : 0;
  const limitStatus =
    capturedBytes >= MAX_OUTPUT_BYTES ? "; output limit reached" : "";
  return `stderr captured ${capturedBytes} bytes${limitStatus}; contents withheld`;
}

function processErrorCode(error) {
  const code =
    error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "unknown";
  return /^[A-Z0-9_]+$/.test(code) ? code : "unknown";
}

function verifyNativeHostWrapper() {
  const wrapperName =
    process.platform === "win32" ? "run_host.bat" : "run_host.sh";
  const wrapperPath = join(DIST_DIR, wrapperName);
  accessSync(wrapperPath, fsConstants.R_OK);
  if (process.platform !== "win32") {
    accessSync(wrapperPath, fsConstants.X_OK);
  }
  accessSync(join(DIST_DIR, "index.js"), fsConstants.R_OK);
  accessSync(
    join(DIST_DIR, "scripts", "native-log-runner.js"),
    fsConstants.R_OK,
  );

  const smokeRoot = mkdtempSync(
    join(resolve(process.env.RUNNER_TEMP || tmpdir()), "webpage-mcp-wrapper-"),
  );
  try {
    const home = join(smokeRoot, "home");
    const localAppData = join(smokeRoot, "local-app-data");
    const temporaryDirectory = join(smokeRoot, "temp");
    const xdgState = join(smokeRoot, "xdg-state");
    const authDirectory = join(smokeRoot, "ipc-auth");
    for (const directory of [
      home,
      localAppData,
      temporaryDirectory,
      xdgState,
      authDirectory,
    ]) {
      mkdirSync(directory, { recursive: true });
    }

    const { command, args } = wrapperCommand(wrapperPath);
    const result = spawnSync(command, args, {
      cwd: DIST_DIR,
      encoding: null,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        LOCALAPPDATA: localAppData,
        TEMP: temporaryDirectory,
        TMP: temporaryDirectory,
        XDG_STATE_HOME: xdgState,
        WEBPAGE_MCP_NATIVE_AUTH_DIR: authDirectory,
        WEBPAGE_MCP_NATIVE_SOCKET: socketPath(smokeRoot),
        WEBPAGE_MCP_NODE_PATH: process.execPath,
      },
      input: encodeNativeMessage({ type: "ping_from_extension" }),
      maxBuffer: MAX_OUTPUT_BYTES,
      timeout: SMOKE_TIMEOUT_MS,
      windowsHide: true,
      windowsVerbatimArguments: process.platform === "win32",
    });

    if (result.error) {
      throw new Error(
        `Native wrapper execution failed (${processErrorCode(result.error)}); ${stderrSummary(result.stderr)}`,
      );
    }
    assert.equal(
      result.status,
      0,
      `Native wrapper failed: ${stderrSummary(result.stderr)}`,
    );
    assert.equal(result.signal, null, "Native wrapper exited on a signal");
    verifyPongFrame(result.stdout);

    const expectedLogPrefix =
      process.platform === "win32"
        ? "native_host_wrapper_windows_"
        : "native_host_wrapper_unix_";
    assert.ok(
      readdirSync(logDirectory(smokeRoot)).some((name) =>
        name.startsWith(expectedLogPrefix),
      ),
      `Native wrapper did not create a ${expectedLogPrefix} log`,
    );
    return { platform: process.platform, wrapperPath };
  } finally {
    rmSync(smokeRoot, { recursive: true, force: true });
  }
}

const result = verifyNativeHostWrapper();
console.log(
  `Native host wrapper handshake verified on ${result.platform}: ${result.wrapperPath}`,
);
