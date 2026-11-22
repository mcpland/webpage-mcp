// Isolated environment for the browser e2e suite: a keyed copy of the built
// extension, a throwaway Chrome profile, a native host wrapper with its own
// HOME/socket/auth directory, and MCP stdio clients. Nothing touches the real
// Chrome profile, ~/.webpage-mcp or the repository build outputs.
import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deriveChromeExtensionId } from "../extension-public-key.mjs";

export const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const NATIVE_HOST_NAME = "com.webpagemcp.nativehost";
// Relative to the run directory: absolute temp paths can exceed the 104-byte
// Unix socket limit on macOS.
const SOCKET_NAME = "native.sock";
const SDK_ROOT = path.join(
  REPO_ROOT,
  "app/mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm",
);

const { Client } = await import(
  pathToFileURL(path.join(SDK_ROOT, "client/index.js")).href
);
const { StdioClientTransport } = await import(
  pathToFileURL(path.join(SDK_ROOT, "client/stdio.js")).href
);

export { sleep };

/** Create the isolated directories, keyed extension and native host registration. */
export function prepareEnvironment({
  extensionDir = path.join(
    REPO_ROOT,
    "app/chrome-extension/.output/chrome-mv3",
  ),
} = {}) {
  const required = [
    path.join(extensionDir, "manifest.json"),
    path.join(REPO_ROOT, "app/mcp-server/dist/index.js"),
    path.join(REPO_ROOT, "app/mcp-server/dist/mcp/mcp-server-stdio.js"),
  ];
  for (const file of required) {
    if (!fs.existsSync(file)) {
      throw new Error(
        `Missing build output ${path.relative(REPO_ROOT, file)}; run pnpm build:shared && pnpm build:mcp && pnpm build:extension first.`,
      );
    }
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wmcp-e2e-"));
  const dirs = {
    root,
    ext: path.join(root, "ext"),
    profile: path.join(root, "profile"),
    home: path.join(root, "home"),
    run: path.join(root, "run"),
    downloads: path.join(root, "downloads"),
  };
  for (const dir of [dirs.profile, dirs.home, dirs.run, dirs.downloads]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  dirs.auth = path.join(dirs.run, "auth");
  dirs.nativeHostLog = path.join(dirs.run, "native-host.log");

  // A key pins the extension ID that the native host manifest allows.
  fs.cpSync(extensionDir, dirs.ext, { recursive: true });
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const key = publicKey
    .export({ format: "der", type: "spki" })
    .toString("base64");
  const manifestPath = path.join(dirs.ext, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.key = key;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  const extensionId = deriveChromeExtensionId(key);

  const quote = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;
  const hostScript = path.join(root, "native-host.sh");
  fs.writeFileSync(
    hostScript,
    [
      "#!/bin/bash",
      `cd ${quote(dirs.run)} || exit 1`,
      `export HOME=${quote(dirs.home)}`,
      `export WEBPAGE_MCP_NATIVE_SOCKET=${quote(SOCKET_NAME)}`,
      `export WEBPAGE_MCP_NATIVE_AUTH_DIR=${quote(dirs.auth)}`,
      `exec ${quote(process.execPath)} ${quote(path.join(REPO_ROOT, "app/mcp-server/dist/index.js"))} "$@" 2>>${quote(dirs.nativeHostLog)}`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  // Chrome reads user-level native messaging manifests from the profile.
  const nativeManifestDir = path.join(dirs.profile, "NativeMessagingHosts");
  fs.mkdirSync(nativeManifestDir, { recursive: true });
  fs.writeFileSync(
    path.join(nativeManifestDir, `${NATIVE_HOST_NAME}.json`),
    JSON.stringify(
      {
        name: NATIVE_HOST_NAME,
        description: "webpage-mcp browser e2e",
        path: hostScript,
        type: "stdio",
        allowed_origins: [`chrome-extension://${extensionId}/`],
      },
      null,
      2,
    ),
  );

  return { ...dirs, extensionId };
}

export async function launchChrome(env, { chromeBinary, headless = true }) {
  const args = [
    ...(headless ? ["--headless=new", "--disable-gpu"] : []),
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--use-mock-keychain",
    "--password-store=basic",
    `--disable-extensions-except=${env.ext}`,
    `--load-extension=${env.ext}`,
    `--user-data-dir=${env.profile}`,
    "--remote-debugging-port=0",
    "--remote-allow-origins=*",
    "--window-size=1280,900",
    ...(process.platform === "linux" ? ["--no-sandbox"] : []),
    "about:blank",
  ];
  const child = spawn(chromeBinary, args, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on(
    "data",
    (chunk) => (stderr = (stderr + chunk).slice(-20_000)),
  );
  child.stdout.resume();

  const portFile = path.join(env.profile, "DevToolsActivePort");
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(`Chrome exited early:\n${stderr}`);
    if (fs.existsSync(portFile)) {
      const port = Number(fs.readFileSync(portFile, "utf8").split("\n")[0]);
      if (port > 0) return { child, port, stderr: () => stderr };
    }
    await sleep(100);
  }
  child.kill("SIGKILL");
  throw new Error(`Chrome did not report a DevTools port:\n${stderr}`);
}

async function cdpConnect(webSocketUrl) {
  const socket = new globalThis.WebSocket(webSocketUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  const pending = new Map();
  let nextId = 0;
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    const waiter = message.id ? pending.get(message.id) : undefined;
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
    else waiter.resolve(message.result);
  });
  return {
    send(method, params = {}) {
      const id = ++nextId;
      socket.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`CDP ${method} timed out`));
        }, 10_000);
        pending.set(id, {
          resolve: (value) => (clearTimeout(timer), resolve(value)),
          reject: (error) => (clearTimeout(timer), reject(error)),
        });
      });
    },
    close: () => socket.close(),
  };
}

/** Send downloads to the run directory instead of the user's Downloads folder. */
export async function routeDownloads(port, downloadPath) {
  const version = await (
    await globalThis.fetch(`http://127.0.0.1:${port}/json/version`)
  ).json();
  const browser = await cdpConnect(version.webSocketDebuggerUrl);
  try {
    await browser.send("Browser.setDownloadBehavior", {
      behavior: "allow",
      downloadPath,
      eventsEnabled: false,
    });
  } finally {
    browser.close();
  }
}

/** Wait for the extension, then ask it to connect its native host. */
export async function connectNativeHost(port, extensionId) {
  const prefix = `chrome-extension://${extensionId}/`;
  const deadline = Date.now() + 45_000;
  for (;;) {
    const targets = await (
      await globalThis.fetch(`http://127.0.0.1:${port}/json/list`)
    ).json();
    if (
      targets.some(
        (t) => t.type === "service_worker" && t.url.startsWith(prefix),
      )
    )
      break;
    if (Date.now() > deadline)
      throw new Error("The extension service worker did not start");
    await sleep(200);
  }

  const target = await (
    await globalThis.fetch(
      `http://127.0.0.1:${port}/json/new?${prefix}popup.html`,
      {
        method: "PUT",
      },
    )
  ).json();
  const cdp = await cdpConnect(target.webSocketDebuggerUrl);
  try {
    await cdp.send("Runtime.enable");
    let last;
    while (Date.now() < deadline) {
      try {
        const evaluation = await cdp.send("Runtime.evaluate", {
          expression: `chrome.runtime.sendMessage({ type: "ensure_native" })`,
          awaitPromise: true,
          returnByValue: true,
        });
        last = evaluation.result?.value;
        if (last?.connected) return last;
      } catch (error) {
        last = String(error);
      }
      await sleep(500);
    }
    throw new Error(`The native host did not connect: ${JSON.stringify(last)}`);
  } finally {
    cdp.close();
    // Close the popup so it never becomes the "active tab" tools fall back to.
    await globalThis
      .fetch(`http://127.0.0.1:${port}/json/close/${target.id}`)
      .catch(() => {});
  }
}

/** Start an MCP stdio server bridged to the isolated native host. */
export async function connectMcpClient(env, extraEnv = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(REPO_ROOT, "app/mcp-server/dist/mcp/mcp-server-stdio.js")],
    cwd: env.run,
    env: {
      ...process.env,
      HOME: env.home,
      WEBPAGE_MCP_NATIVE_SOCKET: SOCKET_NAME,
      WEBPAGE_MCP_NATIVE_AUTH_DIR: env.auth,
      ...extraEnv,
    },
    stderr: "pipe",
  });
  const client = new Client(
    { name: "webpage-mcp-browser-e2e", version: "1.0.0" },
    { capabilities: {} },
  );
  await client.connect(transport);
  return client;
}

/** Call a tool and decode its first text block as JSON when possible. */
export async function callTool(client, name, args = {}, timeoutMs = 60_000) {
  const started = Date.now();
  const result = await client.callTool({ name, arguments: args }, undefined, {
    timeout: timeoutMs,
  });
  const text = (result.content || [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  let json;
  try {
    json = JSON.parse(result.content?.[0]?.text ?? "");
  } catch {
    json = undefined;
  }
  return { ok: !result.isError, result, text, json, ms: Date.now() - started };
}

export async function waitFor(
  predicate,
  { timeoutMs = 5_000, intervalMs = 100 } = {},
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) return undefined;
    await sleep(intervalMs);
  }
}

/** The ref of the first accessibility-tree line matching `pattern`. */
export function findRef(pageContent, pattern) {
  const line = String(pageContent || "")
    .split("\n")
    .find((candidate) => pattern.test(candidate));
  return line?.match(/\[ref=((?:f\d+:)?ref_\d+)\]/)?.[1];
}
