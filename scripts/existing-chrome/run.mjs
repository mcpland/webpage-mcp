import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import {
  REPO_ROOT,
  connectMcpClient,
  connectNativeHost,
  connectStdioClient,
  launchChrome,
  prepareEnvironment,
  sleep,
  stopChrome,
  waitFor,
} from "../browser-e2e/harness.mjs";
import { makeAdapter, Unsupported } from "./adapters.mjs";
import { seedChrome, startSites } from "./fixture.mjs";
import { tasks } from "./tasks.mjs";

const { values } = parseArgs({
  options: {
    adapters: { type: "string", default: "webpage" },
    repeat: { type: "string", default: "3" },
    output: { type: "string" },
    headful: { type: "boolean" },
    list: { type: "boolean" },
    tasks: { type: "string" },
  },
});
if (values.list) {
  console.log(Object.keys(tasks).join("\n"));
  process.exit(0);
}
const selected = values.tasks ? values.tasks.split(",") : Object.keys(tasks);
assert.ok(
  selected.every((name) => Object.hasOwn(tasks, name)) &&
    new Set(selected).size === selected.length,
  "unknown or duplicate task",
);
const adapters = values.adapters.split(",");
const repeat = Number(values.repeat);
assert.ok(
  Number.isSafeInteger(repeat) && repeat > 0,
  "--repeat must be a positive integer",
);
assert.ok(
  adapters.every((a) => ["webpage", "devtools"].includes(a)) &&
    new Set(adapters).size === adapters.length,
  "--adapters accepts webpage,devtools",
);
const chromeBinary = process.env.WEBPAGE_MCP_CHROME_BINARY;
assert.ok(
  chromeBinary && fs.existsSync(chromeBinary),
  "Set WEBPAGE_MCP_CHROME_BINARY to Chrome for Testing",
);
const extensionDir = path.resolve(
  process.env.BENCH_EXTENSION_DIR ??
    path.join(REPO_ROOT, "app/chrome-extension/.output/chrome-mv3"),
);
const serverDir = path.resolve(
  process.env.BENCH_SERVER_DIR ?? path.join(REPO_ROOT, "app/mcp-server"),
);
const devtoolsDir =
  process.env.BENCH_DEVTOOLS_DIR &&
  path.resolve(process.env.BENCH_DEVTOOLS_DIR);
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const digest = (file) =>
  createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const extension = readJson(path.join(extensionDir, "manifest.json"));
const server = readJson(path.join(serverDir, "package.json"));
let devtools;
if (adapters.includes("devtools")) {
  assert.ok(
    devtoolsDir,
    "Set BENCH_DEVTOOLS_DIR to the installed chrome-devtools-mcp package",
  );
  devtools = readJson(path.join(devtoolsDir, "package.json"));
}
const report = {
  schemaVersion: 1,
  started: new Date().toISOString(),
  host: [os.platform(), os.arch(), os.release()].join(" "),
  node: process.version,
  headful: Boolean(values.headful),
  repeat,
  selected,
  versions: {
    extension: extension.version,
    webpage: server.version,
    devtools: devtools?.version,
  },
  sha256: {
    extensionWorker: digest(
      path.join(extensionDir, extension.background.service_worker),
    ),
    nativeHost: digest(path.join(serverDir, "dist/index.js")),
    stdio: digest(path.join(serverDir, server.bin["webpage-mcp-stdio"])),
  },
  trials: [],
  errors: [],
};

let interrupted = false;
const stop = () => {
  interrupted = true;
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
async function runTrial(adapter, iteration) {
  const env = prepareEnvironment({ extensionDir, serverDir });
  let chrome, sites, observer, client;
  try {
    sites = await startSites();
    chrome = await launchChrome(env, {
      chromeBinary,
      headless: !values.headful,
    });
    const endpoint = "http://127.0.0.1:" + chrome.port;
    report.versions.chrome = (
      await (await fetch(endpoint + "/json/version")).json()
    ).Browser;
    await connectNativeHost(chrome.port, env.extensionId);
    observer = await seedChrome(chrome.port, env.extensionId, sites);
    // Tabs, HttpOnly sessions and bookmarks predate MCP initialization.
    client =
      adapter === "webpage"
        ? await connectMcpClient(env, { WEBPAGE_MCP_TOOLSET: "all" })
        : await connectStdioClient(env, [
            path.join(devtoolsDir, devtools.bin["chrome-devtools-mcp"]),
            "--browser-url=" + endpoint,
            "--experimental-structured-content",
            "--page-id-routing",
            "--no-usage-statistics",
            "--no-performance-crux",
          ]);
    const catalog = new Set(
      (await client.listTools()).tools.map((tool) => tool.name),
    );
    for (const name of selected) {
      const task = tasks[name];
      if (interrupted) throw new Error("Interrupted");
      let guard = observer.ids.guard;
      if (name === "cancel-press") guard = observer.ids.cancel;
      if (name.startsWith("action-network")) guard = observer.ids.a;
      await observer.reset(guard);
      sites.clearLogs();
      const calls = [];
      const driver = makeAdapter(adapter, client, catalog, calls);
      const started = performance.now();
      const row = { adapter, iteration, task: name, status: "pass", calls };
      try {
        await task({
          driver,
          sites,
          observer,
          event: async (page, type, matches = () => true) => {
            const entry = await waitFor(() =>
              sites.logs.find(
                (e) => e.page === page && e.type === type && matches(e.data),
              ),
            );
            assert.ok(entry, "page did not report " + page + " " + type);
            return entry;
          },
        });
      } catch (e) {
        row.status = e instanceof Unsupported ? "unsupported" : "fail";
        row.reason = e.message;
      }
      row.ms = Math.round(performance.now() - started);
      await sleep(100); // Drain page POSTs and tab activation events outside the timed interval.
      const activations = await observer.activations();
      if (name === "mid-read-switch") {
        const intentional = activations.indexOf(observer.ids.reader);
        if (intentional !== -1) activations.splice(intentional, 1);
      }
      row.unexpectedTabActivations = activations.length;
      row.wrongTargetWrites = sites.logs.filter((e) => {
        if (e.type === "input")
          return name !== "cross-origin-frame" || e.page !== "/child";
        if (e.type === "mark")
          return !(
            (name === "same-title" && e.page === "/a") ||
            (name === "never-active-tab" && e.page === "/b")
          );
        if (e.type === "checked")
          return !name.startsWith("action-network") || e.page !== "/a";
        return false;
      }).length;
      if (row.unexpectedTabActivations || row.wrongTargetWrites) {
        row.status = "fail";
        row.reason ??= "Unexpected tab activation or wrong-target write";
      }
      row.pageEvents = sites.logs.map((e) => e.page + " " + e.type);
      report.trials.push(row);
      console.log(
        adapter,
        iteration,
        name,
        row.status,
        row.ms + "ms",
        row.reason ?? "",
      );
    }
  } finally {
    sites?.release();
    try {
      await client?.close();
    } finally {
      observer?.close();
      try {
        if (chrome) await stopChrome(chrome.child);
      } finally {
        await sites?.close();
        fs.rmSync(env.root, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 100,
        });
      }
    }
  }
}
for (let i = 1; i <= repeat && !interrupted; i++) {
  for (const adapter of adapters) {
    if (interrupted) break;
    try {
      await runTrial(adapter, i);
    } catch (error) {
      report.errors.push({ iteration: i, adapter, reason: error.message });
      console.error(error);
    }
  }
}
if (values.output)
  fs.writeFileSync(values.output, JSON.stringify(report, null, 2) + "\n");
const count = (status) =>
  report.trials.filter((row) => row.status === status).length;
console.log(
  count("pass") +
    " pass, " +
    count("fail") +
    " fail, " +
    count("unsupported") +
    " unsupported; " +
    report.errors.length +
    " setup/runner error(s)",
);
process.exitCode = interrupted
  ? 130
  : report.errors.length || count("fail")
    ? 1
    : 0;
