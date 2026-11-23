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
  stopChrome,
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

  async "cancel-captured-press"(t) {
    const path = "/cancel-captured-press";
    const tabId = await t.open(path);
    const controller = new AbortController();
    const pending = t.client.callTool(
      { name: "chrome_click_element", arguments: { tabId, selector: "#slider" } },
      undefined, { signal: controller.signal },
    ).then(() => false, () => true);
    try {
      assert.ok(await t.pageLog(path, "pressed"));
    } finally {
      controller.abort();
    }
    assert.ok(await pending);
    assert.ok(await t.pageLog(path, "cancelled"));
    const next = await t.call("chrome_click_element", { tabId, selector: "#next" });
    assert.ok(next.ok, next.text);
    assert.deepEqual((await t.pageLog(path, "next"))?.data, {
      dragging: false, committed: null, activations: 0,
    });
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

  async "same-url-frames"(t) {
    const tabId = await t.open("/sibling-frames");
    for (const id of ["first", "second"]) {
      const click = await t.call("chrome_click_element", { tabId, selector: `#${id} |> #hit` });
      assert.ok(click.ok, click.text);
    }
    const state = await t.call("chrome_javascript", {
      tabId, code: 'return Array.from(document.querySelectorAll("iframe"), f => f.contentDocument.querySelector("button").textContent).join(",")',
    });
    assert.ok(state.ok, state.text);
    assert.match(state.text, /click1,click1/);
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

    const fillChild = await t.call("chrome_fill_or_select", {
      tabId,
      ref: childRef,
      value: "in-child",
    });
    assert.ok(fillChild.ok, fillChild.text);
    assert.ok(
      await t.pageLog(
        "/frame-child",
        "child-input",
        (d) => d.value === "in-child",
      ),
    );
    const fillMain = await t.call("chrome_fill_or_select", {
      tabId,
      ref: mainRef,
      value: "in-main",
    });
    assert.ok(fillMain.ok, fillMain.text);
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
    const filled = await t.call("chrome_fill_or_select", {
      tabId,
      selector: "#email",
      value: "abc",
    });
    assert.ok(filled.ok, filled.text);
    const emailRef = findRef(await t.tree(tabId), /id="email"/);
    const backspace = await t.call("chrome_computer", {
      tabId,
      action: "key",
      ref: emailRef,
      text: "Backspace",
    });
    assert.ok(backspace.ok, backspace.text);
    assert.equal(await t.value(tabId, "#email"), "ab");
    const typed = await t.call("chrome_keyboard", {
      tabId,
      selector: "#bio",
      keys: "Hello World",
    });
    assert.ok(typed.ok, typed.text);
    assert.equal(await t.value(tabId, "#bio"), "Hello World");
    const cleared = await t.call("chrome_keyboard", {
      tabId,
      selector: "#bio",
      keys: "Ctrl+A Backspace",
    });
    assert.ok(cleared.ok, cleared.text);
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

  async "dialog-chain"(t) {
    const tabId = await t.open("/dialog-chain");
    // Answered in one call: the confirm and the alert it leads to.
    const auto = await t.call("chrome_click_element", {
      tabId,
      selector: "#chain",
      dialog: "accept",
    });
    assert.deepEqual(
      (auto.json?.dialogs ?? []).map((d) => `${d.type}:${d.handled}`),
      ["confirm:accept", "alert:accept"],
      auto.text,
    );
    assert.ok(
      await t.pageLog("/dialog-chain", "chain-done", (d) => d.ok === true),
    );

    // Answered one at a time: chrome_handle_dialog reports the follow-up.
    t.fixtures.clearLogs();
    const click = await t.call("chrome_click_element", {
      tabId,
      selector: "#chain",
    });
    assert.equal(click.json?.dialog?.type, "confirm", click.text);
    const first = await t.call("chrome_handle_dialog", {
      tabId,
      action: "dismiss",
    });
    assert.equal(first.json?.nextDialog?.type, "alert", first.text);
    const second = await t.call("chrome_handle_dialog", {
      tabId,
      action: "accept",
    });
    assert.ok(second.ok, second.text);
    assert.ok(
      await t.pageLog("/dialog-chain", "chain-done", (d) => d.ok === false),
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
    assert.equal(click.json?.download?.state, "complete", click.text);
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

  async "network-capture-debugger-from-new-tab-page"(t) {
    const tabIds = async () =>
      (await t.call("get_windows_and_tabs", {})).json.windows.flatMap((w) =>
        w.tabs.map((tab) => tab.tabId),
      );
    const before = new Set(await tabIds());
    // The debugger cannot attach to chrome:// pages; the capture has to move
    // the tab to a blank page first and still see the page's first request.
    await globalThis.fetch(
      `http://127.0.0.1:${t.chromePort}/json/new?chrome://newtab/`,
      {
        method: "PUT",
      },
    );
    const tabId = await waitFor(async () =>
      (await tabIds()).find((id) => !before.has(id)),
    );
    assert.equal(typeof tabId, "number", "the new tab page is listed");
    const capture = await t.call("chrome_network_capture", {
      action: "start",
      tabId,
      url: `${t.base}/polling`,
      durationMs: 2500,
      needResponseBody: true,
    });
    assert.ok(capture.ok, capture.text);
    assert.notEqual(capture.json?.redacted, true, capture.text);
    assert.match(String(capture.json?.tabUrl), /\/polling$/);
    const requests = capture.json?.requests ?? [];
    const firstPing = requests.find((request) =>
      String(request.url).endsWith("/api/ping?i=0"),
    );
    assert.ok(
      firstPing,
      requests.map((request) => String(request.url)).join("\n"),
    );
    assert.match(
      String(firstPing.responseBody ?? ""),
      /"pong"\s*:\s*0/,
      JSON.stringify(firstPing),
    );
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

  async "submit-interrupted-by-focus-dialog"(t) {
    for (const [tool, args] of [
      ["chrome_fill_or_select", { selector: "#target", value: "test" }],
      ["chrome_computer", { action: "fill_form", elements: [{ selector: "#target", value: "test" }] }],
    ]) {
      const tabId = await t.open("/submit-focus-dialog");
      const result = await t.call(tool, { ...args, tabId, submit: true });
      assert.equal(result.json?.dialog?.handled, false, result.text);
      await t.call("chrome_handle_dialog", { tabId, action: "accept" });
      assert.equal(result.json?.submitted, false, result.text);
      const actual = await t.call("chrome_javascript", {
        tabId,
        code: "return document.body.dataset.submitted || 'no'",
      });
      assert.equal(actual.json?.result, "no", actual.text);
    }
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
    const logged = await t.call("chrome_javascript", {
      tabId,
      code: 'console.error("logged before the snapshot"); return true',
    });
    assert.ok(logged.ok, logged.text);
    const snapshot = await t.call("chrome_console", { tabId, waitMs: 0 });
    assert.ok(snapshot.ok, snapshot.text);
    assert.ok(
      snapshot.text.includes("logged before the snapshot"),
      snapshot.text,
    );
    assert.ok(
      (snapshot.json?.totalDurationMs ?? snapshot.ms) < 1500,
      `waitMs=0 took ${snapshot.json?.totalDurationMs ?? snapshot.ms}ms (wall ${snapshot.ms}ms)`,
    );
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

function makeContext({ client, fixtures, env, chromePort }) {
  const call = (name, args, timeoutMs) =>
    callTool(client, name, args, timeoutMs);
  return {
    client,
    fixtures,
    env,
    chromePort,
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
  const keepTempDir = argv.includes("--keep");
  const removeTempDir = () => {
    if (keepTempDir) {
      console.log(`\nKept ${env.root}`);
      return;
    }
    try {
      fs.rmSync(env.root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 200,
      });
    } catch (error) {
      // Leftover temp files must not turn a passing run into a failure.
      console.warn(`Could not remove ${env.root}: ${error.message}`);
    }
  };

  let fixtures;
  let chrome;
  let client;
  const results = [];
  let fatalError;
  let cleanedUp = false;
  const cleanupResources = async () => {
    if (cleanedUp) return;
    cleanedUp = true;
    await client?.close().catch(() => {});
    if (chrome) await stopChrome(chrome.child).catch(() => {});
    if (fixtures) await fixtures.close().catch(() => {});
  };
  const onSignal = (signal) => {
    console.error(`\nReceived ${signal}, cleaning up...`);
    void cleanupResources().finally(() => {
      removeTempDir();
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    fixtures = await startFixtureServer();
    chrome = await launchChrome(env, {
      chromeBinary,
      headless: !argv.includes("--headful"),
    });
    await routeDownloads(chrome.port, env.downloads);
    await connectNativeHost(chrome.port, env.extensionId);
    client = await connectMcpClient(env);
    const context = makeContext({
      client,
      fixtures,
      env,
      chromePort: chrome.port,
    });

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
  } catch (error) {
    fatalError = error;
    console.error(String(error?.stack || error));
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await cleanupResources();

    const failed = results.filter((result) => !result.ok);
    if (results.length > 0) {
      console.log(
        `\n${results.length - failed.length}/${results.length} scenarios passed`,
      );
    }
    if (fatalError || failed.length > 0) {
      console.log(`\nnative host log (tail):\n${tail(env.nativeHostLog)}`);
      console.log(
        `\nChrome stderr (tail):\n${chrome?.stderr().split("\n").slice(-20).join("\n") ?? "(no Chrome output)"}`,
      );
    }
    removeTempDir();
  }

  const failed = results.filter((result) => !result.ok);
  return fatalError || failed.length > 0 ? 1 : 0;
}

process.exitCode = await main();
// Child processes and sockets may keep the loop alive; the result is final.
process.exit(process.exitCode);
