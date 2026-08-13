#!/usr/bin/env node

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import console from "node:console";
import fs from "node:fs";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { deriveChromeExtensionId } from "./extension-public-key.mjs";

const STARTUP_TIMEOUT_MS = 45_000;
const CDP_TIMEOUT_MS = 20_000;
const MAX_DIAGNOSTIC_BYTES = 64 * 1024;
const EXTENSION_ID_PATTERN = /^[a-p]{32}$/;

function requiredEnvironment(name) {
  const value = process.env[name];
  assert.ok(value, `${name} is required for the browser native handshake`);
  return value;
}

function boundedDiagnostics(stream) {
  let retained = Buffer.alloc(0);
  stream.on("data", (chunk) => {
    const combined = Buffer.concat([retained, Buffer.from(chunk)]);
    retained = combined.subarray(
      Math.max(0, combined.length - MAX_DIAGNOSTIC_BYTES),
    );
  });
  return () => `captured ${retained.length} bytes; contents withheld`;
}

function delay(milliseconds) {
  return new Promise((resolvePromise) =>
    setTimeout(resolvePromise, milliseconds),
  );
}

async function waitForDevtoolsPort(userDataDir, child) {
  const activePortPath = path.join(userDataDir, "DevToolsActivePort");
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    assert.equal(
      child.exitCode === null && child.signalCode === null,
      true,
      "Chrome exited before DevTools started",
    );
    try {
      const [rawPort] = (await readFile(activePortPath, "utf8")).split("\n");
      const port = Number(rawPort);
      if (Number.isSafeInteger(port) && port > 0 && port <= 65535) return port;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await delay(100);
  }
  throw new Error("Chrome DevTools did not start before the timeout");
}

async function fetchTargets(port) {
  const response = await globalThis.fetch(
    `http://127.0.0.1:${port}/json/list`,
    {
      redirect: "error",
      signal: globalThis.AbortSignal.timeout(5_000),
    },
  );
  assert.equal(
    response.ok,
    true,
    `Chrome target list returned ${response.status}`,
  );
  const targets = await response.json();
  assert.ok(Array.isArray(targets), "Chrome target list must be an array");
  return targets;
}

async function waitForExtensionTarget(port, extensionId, child) {
  const prefix = `chrome-extension://${extensionId}/`;
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    assert.equal(
      child.exitCode === null && child.signalCode === null,
      true,
      "Chrome exited before the extension loaded",
    );
    const targets = (await fetchTargets(port)).filter(
      (candidate) =>
        candidate &&
        (candidate.type === "page" || candidate.type === "service_worker") &&
        typeof candidate.url === "string" &&
        candidate.url.startsWith(prefix) &&
        typeof candidate.webSocketDebuggerUrl === "string",
    );
    const target =
      targets.find((candidate) => candidate.url === `${prefix}popup.html`) ??
      targets.find((candidate) => candidate.type === "page") ??
      targets.find((candidate) => candidate.type === "service_worker");
    if (target) return target;
    await delay(200);
  }
  throw new Error("Chrome did not expose the expected extension target");
}

async function connectCdp(webSocketUrl) {
  const socket = new globalThis.WebSocket(webSocketUrl);
  const pending = new Map();
  let nextId = 1;
  await new Promise((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(
      () => rejectPromise(new Error("CDP WebSocket connection timed out")),
      CDP_TIMEOUT_MS,
    );
    socket.addEventListener(
      "open",
      () => {
        clearTimeout(timeout);
        resolvePromise();
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timeout);
        rejectPromise(new Error("CDP WebSocket connection failed"));
      },
      { once: true },
    );
  });

  socket.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (!Number.isSafeInteger(message.id)) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timeout);
    if (message.error) {
      const code = Number.isSafeInteger(message.error.code)
        ? message.error.code
        : "unknown";
      request.reject(new Error(`CDP command failed (code=${code})`));
    } else request.resolve(message.result);
  });

  socket.addEventListener("close", () => {
    for (const request of pending.values()) {
      clearTimeout(request.timeout);
      request.reject(
        new Error("CDP WebSocket closed before command completion"),
      );
    }
    pending.clear();
  });

  return {
    call(method, params = {}) {
      const id = nextId;
      nextId += 1;
      return new Promise((resolvePromise, rejectPromise) => {
        const timeout = setTimeout(() => {
          pending.delete(id);
          rejectPromise(new Error(`CDP ${method} timed out`));
        }, CDP_TIMEOUT_MS);
        pending.set(id, {
          resolve: resolvePromise,
          reject: rejectPromise,
          timeout,
        });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      socket.close();
    },
  };
}

function runtimeValue(evaluation) {
  if (evaluation?.result?.objectId && !evaluation.result.value) {
    return undefined;
  }
  return evaluation?.result?.value;
}

async function waitForExit(child, milliseconds) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise((resolvePromise) => {
    const timeout = setTimeout(() => resolvePromise(false), milliseconds);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolvePromise(true);
    });
  });
}

async function main() {
  const chromeBinary = await realpath(
    requiredEnvironment("WEBPAGE_MCP_CHROME_BINARY"),
  );
  const extensionDir = await realpath(
    requiredEnvironment("WEBPAGE_MCP_EXTENSION_DIR"),
  );
  const extensionId = requiredEnvironment("WEBPAGE_MCP_EXPECTED_EXTENSION_ID");
  assert.match(extensionId, EXTENSION_ID_PATTERN);
  fs.accessSync(chromeBinary, fs.constants.X_OK);

  const extensionManifest = JSON.parse(
    await readFile(path.join(extensionDir, "manifest.json"), "utf8"),
  );
  assert.equal(
    deriveChromeExtensionId(extensionManifest.key),
    extensionId,
    "extension manifest key does not derive the expected smoke ID",
  );
  assert.ok(
    extensionManifest.permissions?.includes("nativeMessaging"),
    "extension manifest must request nativeMessaging",
  );

  const smokeRoot = await mkdtemp(
    path.join(
      path.resolve(process.env.RUNNER_TEMP || tmpdir()),
      "webpage-mcp-browser-native-",
    ),
  );
  const userDataDir = path.join(smokeRoot, "chrome-profile");
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    `--disable-extensions-except=${extensionDir}`,
    `--load-extension=${extensionDir}`,
    `--user-data-dir=${userDataDir}`,
    "--remote-debugging-port=0",
    "--remote-allow-origins=*",
    ...(process.platform === "linux" ? ["--no-sandbox"] : []),
    `chrome-extension://${extensionId}/popup.html`,
  ];
  const child = spawn(chromeBinary, args, {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const stdoutSummary = boundedDiagnostics(child.stdout);
  const stderrSummary = boundedDiagnostics(child.stderr);
  let cdp;
  try {
    const port = await waitForDevtoolsPort(userDataDir, child);
    const target = await waitForExtensionTarget(port, extensionId, child);
    cdp = await connectCdp(target.webSocketDebuggerUrl);
    await cdp.call("Runtime.enable");
    const contextProbe = await cdp.call("Runtime.evaluate", {
      expression:
        "({ href: globalThis.location?.href, runtimeType: typeof globalThis.chrome?.runtime })",
      returnByValue: true,
    });
    assert.equal(
      runtimeValue(contextProbe)?.runtimeType,
      "object",
      `selected Chrome target has no extension runtime (${target.type}: ${target.url})`,
    );
    const evaluation = await cdp.call("Runtime.evaluate", {
      expression: `(async () => {
        const ensure = await chrome.runtime.sendMessage({ type: "ensure_native" });
        const ping = await chrome.runtime.sendMessage({ type: "ping_native" });
        return { runtimeId: chrome.runtime.id, ensure, ping };
      })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    assert.equal(
      evaluation.exceptionDetails,
      undefined,
      "extension handshake evaluation raised an exception",
    );
    const result = runtimeValue(evaluation);
    assert.equal(result?.runtimeId, extensionId);
    assert.equal(
      result?.ensure?.success,
      true,
      `extension could not ensure native host: ${String(result?.ensure?.error ?? "no reason")}`,
    );
    assert.equal(
      result?.ensure?.connected,
      true,
      "native host did not connect",
    );
    assert.equal(
      result?.ping?.connected,
      true,
      "native host ping did not return pong",
    );
    console.log(
      `Real Chrome extension/native host handshake verified for ${extensionId}`,
    );
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)} ` +
        `(Chrome stdout ${stdoutSummary()}; stderr ${stderrSummary()})`,
    );
  } finally {
    cdp?.close();
    child.kill("SIGTERM");
    if (!(await waitForExit(child, 5_000))) {
      child.kill("SIGKILL");
      await waitForExit(child, 5_000);
    }
    await rm(smokeRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
