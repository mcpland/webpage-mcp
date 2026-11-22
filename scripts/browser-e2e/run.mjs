#!/usr/bin/env node
// Browser e2e suite: drives the built extension and MCP server through a real
// Chrome (for Testing) with MCP tool calls, and asserts what the pages saw.
//
//   WEBPAGE_MCP_CHROME_BINARY=/path/to/chrome node scripts/browser-e2e/run.mjs [name ...]
//
// Flags: --headful (show the browser), --keep (keep the temp directory),
// --list (print scenario names). Build first: pnpm build:shared && pnpm build:mcp
// && pnpm build:extension. Branded Chrome ignores --load-extension since
// version 137, so use Chrome for Testing.
import assert from "node:assert/strict";
import console from "node:console";
import fs from "node:fs";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { startFixtureServer } from "./fixtures.mjs";
import {
  callTool,
  connectMcpClient,
  connectNativeHost,
  findRef,
  launchChrome,
  prepareEnvironment,
  routeDownloads,
  waitFor,
} from "./harness.mjs";

const SCENARIO_TIMEOUT_MS = 90_000;

/** @type {Record<string, (t: ReturnType<typeof makeContext>) => Promise<void>>} */
const scenarios = {
  async "tool-list"({ client }) {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    for (const name of [
      "chrome_navigate",
      "chrome_read_page",
      "chrome_computer",
    ]) {
      assert.ok(names.includes(name), `${name} is listed`);
    }
    for (const tool of tools)
      assert.equal(tool.inputSchema?.type, "object", tool.name);
  },

  async javascript(t) {
    const tabId = await t.open("/simple");
    const run = await t.call("chrome_javascript", {
      tabId,
      code: "return document.title",
    });
    assert.equal(run.json?.result, "Simple", run.text);
  },

  async "read-page-tree"(t) {
    const tabId = await t.open("/nested");
    const tree = await t.tree(tabId);
    assert.equal(tree.split('"Quarterly revenue report"').length - 1, 1, tree);
    assert.ok(
      !tree.includes("do-not-show"),
      "script source stays out of the tree",
    );
    assert.match(tree.split("\n")[0], /^- generic \[ref=ref_\d+\] \(x=/);
    assert.match(tree, /listitem "Item one"/);
  },

  async "read-page-scope"(t) {
    const tabId = await t.open("/long");
    assert.ok(
      !(await t.tree(tabId)).includes("Bottom Button"),
      "viewport scope",
    );
    const whole = await t.tree(tabId, { scope: "page" });
    const ref = findRef(whole, /button "Bottom Button"/);
    assert.ok(ref, whole);
    const click = await t.call("chrome_click_element", { tabId, ref });
    assert.ok(click.ok, click.text);
    assert.ok(
      await t.pageLog("/long", "bottom-click"),
      "the page saw the click",
    );
  },

  async "navigate-waits-for-load"(t) {
    const nav = await t.call("chrome_navigate", {
      url: `${t.base}/slow`,
      includeSnapshot: true,
    });
    assert.ok(nav.ok, nav.text);
    assert.equal(nav.json?.status, "complete");
    const snapshot = nav.result.content?.[1]?.text ?? "";
    assert.match(snapshot, /Late Button/);
  },

  async "iframe-refs"(t) {
    const tabId = await t.open("/frames");
    const frames = await waitFor(async () => {
      const read = await t.call("chrome_read_page", { tabId });
      const child = read.json?.frames?.find((f) =>
        String(f.url).includes("/frame-child"),
      );
      return child ? { read, child } : undefined;
    });
    assert.ok(frames, "the child frame is listed");
    const mainRef = findRef(frames.read.json.pageContent, /MAIN INPUT/);
    const childRead = await t.call("chrome_read_page", {
      tabId,
      frameId: frames.child.frameId,
    });
    const childRef = findRef(childRead.json?.pageContent, /CHILD INPUT/);
    assert.match(String(childRef), /^f\d+:ref_\d+$/, childRead.text);

    await t.call("chrome_fill_or_select", {
      tabId,
      ref: childRef,
      value: "in-child",
    });
    assert.ok(
      await t.pageLog(
        "/frame-child",
        "child-input",
        (d) => d.value === "in-child",
      ),
    );
    await t.call("chrome_fill_or_select", {
      tabId,
      ref: mainRef,
      value: "in-main",
    });
    assert.ok(
      await t.pageLog("/frames", "main-input", (d) => d.value === "in-main"),
    );
    assert.ok(
      !t.fixtures.logs.some(
        (l) => l.type === "main-input" && l.data.value === "in-child",
      ),
      "the child ref never wrote into the main frame",
    );
  },

  async keyboard(t) {
    const tabId = await t.open("/form");
    await t.call("chrome_fill_or_select", {
      tabId,
      selector: "#email",
      value: "abc",
    });
    const emailRef = findRef(await t.tree(tabId), /id="email"/);
    await t.call("chrome_computer", {
      tabId,
      action: "key",
      ref: emailRef,
      text: "Backspace",
    });
    assert.equal(await t.value(tabId, "#email"), "ab");
    await t.call("chrome_keyboard", {
      tabId,
      selector: "#bio",
      keys: "Hello World",
    });
    assert.equal(await t.value(tabId, "#bio"), "Hello World");
    await t.call("chrome_keyboard", {
      tabId,
      selector: "#bio",
      keys: "Ctrl+A Backspace",
    });
    assert.equal(await t.value(tabId, "#bio"), "");
  },

  async dialogs(t) {
    const tabId = await t.open("/dialog");
    const click = await t.call("chrome_click_element", {
      tabId,
      selector: "#del",
    });
    assert.deepEqual(
      { type: click.json?.dialog?.type, handled: click.json?.dialog?.handled },
      { type: "confirm", handled: false },
      click.text,
    );
    const answer = await t.call("chrome_handle_dialog", {
      tabId,
      action: "accept",
    });
    assert.ok(answer.ok, answer.text);
    assert.ok(
      await t.pageLog("/dialog", "confirm-result", (d) => d.ok === true),
    );

    t.fixtures.clearLogs();
    const inline = await t.call("chrome_click_element", {
      tabId,
      selector: "#del",
      dialog: "dismiss",
    });
    assert.equal(inline.json?.dialog?.handled, "dismiss", inline.text);
    assert.ok(
      await t.pageLog("/dialog", "confirm-result", (d) => d.ok === false),
    );
  },

  async screenshot(t) {
    const tabId = await t.open("/simple");
    const shot = await t.call("chrome_screenshot", { tabId });
    const image = shot.result.content?.find((block) => block.type === "image");
    assert.ok(image && /^image\//.test(image.mimeType), shot.text);
    assert.ok(image.data.length > 1000, "image data is present");
  },

  async download(t) {
    const tabId = await t.open("/download");
    const click = await t.call("chrome_click_element", {
      tabId,
      selector: "#dl",
      waitForDownload: true,
    });
    assert.ok(click.ok, click.text);
    assert.match(
      String(click.json?.download?.filename),
      /report.*\.txt$/,
      click.text,
    );
  },

  async "network-capture-one-shot"(t) {
    const capture = await t.call("chrome_network_capture", {
      action: "start",
      url: `${t.base}/polling`,
      durationMs: 2500,
    });
    assert.ok(capture.ok, capture.text);
    assert.equal(capture.json?.oneShot, true);
    const urls = (capture.json?.requests ?? []).map((request) =>
      String(request.url),
    );
    // i=0 fires as the page's script starts: the capture listened before the page loaded.
    assert.ok(
      urls.some((url) => url.endsWith("/api/ping?i=0")),
      urls.join("\n"),
    );
    const stop = await t.call("chrome_network_capture", { action: "stop" });
    assert.equal(stop.ok, false, "the one-shot capture did not keep running");
  },

  async "switch-tab-by-url-or-title"(t) {
    await t.open("/simple");
    await t.open("/form");
    const byTitle = await t.call("chrome_switch_tab", { title: "Simple" });
    assert.equal(byTitle.json?.title, "Simple", byTitle.text);
    assert.match((await t.call("chrome_read_page", {})).text, /Example Domain/);
    const byUrl = await t.call("chrome_switch_tab", { url: "/form" });
    assert.ok(byUrl.ok, byUrl.text);
    assert.match((await t.call("chrome_read_page", {})).text, /Login/);
  },

  async "fill-submit-and-type-clear"(t) {
    const tabId = await t.open("/form");
    t.fixtures.clearLogs();
    const fill = await t.call("chrome_fill_or_select", {
      tabId,
      selector: "#email",
      value: "a@b.c",
      submit: true,
    });
    assert.equal(fill.json?.submitted, true, fill.text);
    assert.ok(await t.pageLog("/form", "submit", (d) => d.email === "a@b.c"));

    const nameRef = findRef(await t.tree(tabId), /id="name"/);
    const typed = await t.call("chrome_computer", {
      tabId,
      action: "type",
      ref: nameRef,
      text: "Ada",
      clear: true,
    });
    assert.ok(typed.ok, typed.text);
    assert.equal(await t.value(tabId, "#name"), "Ada");
  },

  async "page-change-summary"(t) {
    let tabId = await t.open("/links");
    const blank = await t.call("chrome_click_element", {
      tabId,
      selector: "#blank",
    });
    assert.match(
      String(blank.json?.pageChange?.newTabs?.[0]?.url),
      /\/simple\?from=blank$/,
      blank.text,
    );
    const noop = await t.call("chrome_click_element", {
      tabId,
      selector: "#noop",
    });
    assert.equal(noop.json?.pageChange, undefined, noop.text);
    const same = await t.call("chrome_click_element", {
      tabId,
      selector: "#same",
    });
    assert.equal(same.json?.pageChange?.navigated, true, same.text);
    assert.match(String(same.json?.pageChange?.url), /\/simple$/);

    tabId = await t.open("/realform");
    const submit = await t.call("chrome_fill_or_select", {
      tabId,
      selector: "#q",
      value: "mcp",
      submit: true,
    });
    assert.match(
      String(submit.json?.pageChange?.url),
      /\/submitted\?q=mcp$/,
      submit.text,
    );
    assert.equal(submit.json?.pageChange?.title, "Submitted");
  },

  async "console-snapshot-wait"(t) {
    const tabId = await t.open("/simple");
    await t.call("chrome_javascript", {
      tabId,
      code: 'console.error("logged before the snapshot"); return true',
    });
    const snapshot = await t.call("chrome_console", { tabId, waitMs: 0 });
    assert.ok(
      snapshot.text.includes("logged before the snapshot"),
      snapshot.text,
    );
    assert.ok(snapshot.ms < 1500, `waitMs=0 returned in ${snapshot.ms}ms`);
  },

  async toolset(t) {
    const core = await connectMcpClient(t.env, { WEBPAGE_MCP_TOOLSET: "core" });
    try {
      const names = (await core.listTools()).tools.map((tool) => tool.name);
      assert.ok(names.includes("chrome_navigate"));
      assert.ok(!names.includes("chrome_console"));
      assert.ok(!names.some((name) => name.startsWith("workflow_")));
      const refused = await callTool(core, "chrome_console", {});
      assert.equal(refused.ok, false);
      assert.match(refused.text, /not enabled/);
    } finally {
      await core.close();
    }
  },
};

function makeContext({ client, fixtures, env }) {
  const call = (name, args, timeoutMs) =>
    callTool(client, name, args, timeoutMs);
  return {
    client,
    fixtures,
    env,
    base: fixtures.base,
    call,
    async open(pathname) {
      const nav = await call("chrome_navigate", {
        url: `${fixtures.base}${pathname}`,
      });
      assert.ok(nav.ok && typeof nav.json?.tabId === "number", nav.text);
      return nav.json.tabId;
    },
    async tree(tabId, extra = {}) {
      const read = await call("chrome_read_page", { tabId, ...extra });
      assert.ok(read.ok, read.text);
      return String(read.json?.pageContent ?? "");
    },
    async value(tabId, selector) {
      const read = await call("chrome_javascript", {
        tabId,
        code: `return document.querySelector(${JSON.stringify(selector)}).value`,
      });
      return read.json?.result;
    },
    pageLog(pagePath, type, match = () => true) {
      return waitFor(() =>
        fixtures.logs.find(
          (l) => l.page === pagePath && l.type === type && match(l.data),
        ),
      );
    },
  };
}

function withTimeout(promise, ms, name) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${name} timed out after ${ms}ms`)),
        ms,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

function tail(file, lines = 40) {
  try {
    return fs.readFileSync(file, "utf8").split("\n").slice(-lines).join("\n");
  } catch {
    return "(no log)";
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--list")) {
    console.log(Object.keys(scenarios).join("\n"));
    return 0;
  }
  const selected = argv.filter((arg) => !arg.startsWith("--"));
  const unknown = selected.filter((name) => !scenarios[name]);
  if (unknown.length > 0) {
    console.error(`Unknown scenario(s): ${unknown.join(", ")}. Use --list.`);
    return 2;
  }
  const chromeBinary = process.env.WEBPAGE_MCP_CHROME_BINARY;
  if (!chromeBinary) {
    console.error(
      "Set WEBPAGE_MCP_CHROME_BINARY to a Chrome for Testing binary (branded Chrome ignores --load-extension).",
    );
    return 2;
  }

  const env = prepareEnvironment({
    extensionDir: process.env.WEBPAGE_MCP_EXTENSION_DIR || undefined,
  });
  const fixtures = await startFixtureServer();
  let chrome;
  let client;
  const results = [];
  try {
    chrome = await launchChrome(env, {
      chromeBinary,
      headless: !argv.includes("--headful"),
    });
    await routeDownloads(chrome.port, env.downloads);
    await connectNativeHost(chrome.port, env.extensionId);
    client = await connectMcpClient(env);
    const context = makeContext({ client, fixtures, env });

    for (const name of selected.length > 0
      ? selected
      : Object.keys(scenarios)) {
      const started = Date.now();
      fixtures.clearLogs();
      try {
        await withTimeout(scenarios[name](context), SCENARIO_TIMEOUT_MS, name);
        results.push({ name, ok: true, ms: Date.now() - started });
        console.log(`ok   ${name} (${Date.now() - started}ms)`);
      } catch (error) {
        results.push({ name, ok: false, ms: Date.now() - started, error });
        console.log(
          `FAIL ${name} (${Date.now() - started}ms)\n${String(error?.stack || error)}`,
        );
      }
    }
  } finally {
    await client?.close().catch(() => {});
    chrome?.child.kill("SIGTERM");
    await fixtures.close();
  }

  const failed = results.filter((result) => !result.ok);
  console.log(
    `\n${results.length - failed.length}/${results.length} scenarios passed`,
  );
  if (failed.length > 0) {
    console.log(`\nnative host log (tail):\n${tail(env.nativeHostLog)}`);
    console.log(
      `\nChrome stderr (tail):\n${chrome?.stderr().split("\n").slice(-20).join("\n")}`,
    );
  }
  if (argv.includes("--keep")) console.log(`\nKept ${env.root}`);
  else fs.rmSync(env.root, { recursive: true, force: true });
  return failed.length > 0 ? 1 : 0;
}

process.exitCode = await main();
// Child processes and sockets may keep the loop alive; the result is final.
process.exit(process.exitCode);
