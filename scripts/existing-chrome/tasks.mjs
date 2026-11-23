import assert from "node:assert/strict";
import { sleep, waitFor } from "../browser-e2e/harness.mjs";
import { ToolError } from "./adapters.mjs";

const marker = "return document.querySelector('#marker').textContent";
async function page(driver, url) {
  const pages = await driver.pages();
  const matches = pages.filter((p) => p.url === url);
  assert.equal(
    matches.length,
    1,
    "expected one existing tab for " + new URL(url).pathname,
  );
  return matches[0].id;
}

async function actionNetwork({ driver, sites, event }, format, body = false) {
  const id = await page(driver, sites.a);
  await driver.startCapture(id, body);
  let requests, observed;
  try {
    await driver.mark(
      id,
      "#check-" + format,
      format === "html" ? "Check gateway" : "Check API",
    );
    observed = (await event("/a", "checked", (data) => data.status === 503))
      .data;
  } finally {
    requests = await driver.finishCapture(id);
  }
  const match = requests?.find((r) => r.url === observed.url);
  assert.ok(
    match,
    "MCP capture omitted the observed " +
      format +
      " HTTP 503 request (" +
      (requests?.length ?? 0) +
      " requests returned)",
  );
  assert.match(
    String(match.statusCode ?? match.status),
    /\b503\b/,
    "tool reported the HTTP failure",
  );
}

export const tasks = {
  async "same-title"({ driver, sites, event }) {
    const pages = await driver.pages();
    const a = pages.find((p) => p.url === sites.a);
    const b = pages.find((p) => p.url === sites.b);
    assert.ok(
      a && b && a.id !== b.id && a.title === b.title,
      "two existing tabs with the same title",
    );
    await driver.mark(a.id, "#mark", "Mark item");
    await event("/a", "mark");
    assert.equal(
      sites.logs.filter((l) => l.type === "mark").length,
      1,
      "exactly one activation",
    );
  },
  async "never-active-tab"({ driver, sites, event }) {
    const id = await page(driver, sites.b);
    await driver.mark(id, "#mark", "Mark item");
    await event("/b", "mark");
  },
  async "mid-read-switch"({ driver, sites, observer }) {
    const id = await page(driver, sites.a);
    // The server barrier makes the user switch occur DURING the request, even on a fast machine.
    const pending = driver.script(id, "await fetch('/hold');" + marker);
    pending.catch(() => {}); // The fixture must release its barrier even on failure.
    try {
      assert.ok(await waitFor(sites.holding), "read reached the barrier");
      await observer.activate(observer.ids.reader);
    } finally {
      sites.release();
      await pending.catch(() => {}); // Settle the tool before starting another task.
    }
    assert.equal(
      await pending,
      sites.markers.a,
      "authenticated content from the original target",
    );
  },
  async "cross-origin-frame"({ driver, sites, event }) {
    const id = await page(driver, sites.a);
    await driver.childFill(id, "frame-only");
    const entry = await event(
      "/child",
      "input",
      (data) => data === "frame-only",
    );
    assert.equal(entry.data, "frame-only");
  },
  "action-network-json": (ctx) => actionNetwork(ctx, "json"),
  "action-network-html": (ctx) => actionNetwork(ctx, "html"),
  "action-network-html-detailed": (ctx) => actionNetwork(ctx, "html", true),
  async "cancel-press"({ driver, sites, event }) {
    const id = await page(driver, sites.base + "/cancel-captured-press");
    const controller = new AbortController();
    const pending = driver
      .mark(id, "#slider", "Slider", controller.signal, false)
      .then(
        () => "completed",
        () => "rejected",
      );
    try {
      await event("/cancel-captured-press", "pressed");
    } finally {
      controller.abort();
      await pending;
    }
    assert.equal(
      await pending,
      "rejected",
      "request was still in flight when cancelled",
    );
    // The fixture holds the press for 1.2 s. Probe only AFTER it could have committed.
    await sleep(1400);
    await driver.mark(id, "#next", "Next", undefined, false);
    const { data } = await event("/cancel-captured-press", "next");
    assert.deepEqual(
      data,
      { dragging: false, committed: null, activations: 0 },
      "post-cancel page state: " + JSON.stringify(data),
    );
  },
  async "bookmark-portals"({ driver, sites, observer }) {
    const urls = await driver.bookmarks(observer.folderPath);
    assert.deepEqual(
      [...urls].sort(),
      [sites.a, sites.b].sort(),
      "actual folder entries on two origins",
    );
    const pages = await driver.pages();
    for (const url of urls) {
      const target = pages.find((p) => p.url === url);
      assert.ok(target, "existing bookmarked portal");
      const result = await driver.script(target.id, marker);
      assert.equal(
        result,
        sites.markers[new URL(url).pathname.slice(1)],
        "read the existing authenticated session",
      );
    }
  },
  async "bookmark-short-name"({ driver, sites }) {
    const urls = await driver.bookmarks("Benchmark sites");
    assert.deepEqual(
      [...urls].sort(),
      [sites.a, sites.b].sort(),
      "resolve a unique folder by its visible name",
    );
  },
  async "closed-target"({ driver, sites, observer }) {
    const id = await page(driver, sites.base + "/guard?retired");
    const click = await driver.prepareMark(id, "#mark", "Mark item");
    await observer.remove(observer.ids.closed);
    await assert.rejects(
      click,
      ToolError,
      "a click on a closed target must report an MCP error",
    );
  },
};
