import assert from "node:assert/strict";
import { findRef } from "../browser-e2e/harness.mjs";

export class ToolError extends Error {}
export class Unsupported extends Error {}

// Count actual tools/call requests (including failed/cancelled requests).
export function makeAdapter(name, client, catalog, calls) {
  const call = async (tool, args, signal) => {
    if (!catalog.has(tool))
      throw new Unsupported(tool + " is absent from the advertised catalog");
    const timing = { tool };
    calls.push(timing);
    const start = performance.now();
    try {
      const result = await client.callTool(
        { name: tool, arguments: args },
        undefined,
        { signal, timeout: 12_000 },
      );
      const text = result.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      if (result.isError) throw new ToolError(tool + ": " + text.slice(0, 500));
      return { text, data: result.structuredContent };
    } finally {
      timing.ms = Math.round(performance.now() - start);
    }
  };
  if (name === "webpage") {
    async function json(tool, args, signal) {
      const response = JSON.parse((await call(tool, args, signal)).text);
      if (response.success === false)
        throw new ToolError(
          tool + ": " + JSON.stringify(response).slice(0, 500),
        );
      return response;
    }
    return {
      async pages() {
        const { windows } = await json("get_windows_and_tabs", {});
        return windows.flatMap((w) =>
          w.tabs.map((t) => ({ url: t.url, id: t.tabId, title: t.title })),
        );
      },
      async prepareMark(tabId, selector) {
        return () =>
          json("chrome_click_element", { tabId, selector, background: true });
      },
      async mark(tabId, selector, _label, signal, background = true) {
        await json(
          "chrome_click_element",
          { tabId, selector, background },
          signal,
        );
      },
      async script(tabId, code) {
        return (await json("chrome_javascript", { tabId, code })).result;
      },
      async childFill(tabId, value) {
        const tree = await json("chrome_read_page", {
          tabId,
          background: true,
        });
        const child = tree.frames?.find(
          (frame) => new URL(frame.url).pathname === "/child",
        );
        assert.ok(child, "cross-origin frame missing from page inventory");
        const inner = await json("chrome_read_page", {
          tabId,
          frameId: child.frameId,
          background: true,
        });
        // A native wrapping label can be a separate tree node. Use its
        // sole textbox when the renderer puts the name on the label.
        const fields = inner.pageContent
          .split("\n")
          .filter((line) => /textbox|\binput\b/i.test(line));
        const field =
          fields.find((line) => line.includes("Frame note")) ??
          (fields.length === 1 && inner.pageContent.includes("Frame note")
            ? fields[0]
            : "");
        const ref = findRef(field, /./);
        assert.ok(
          ref,
          "Frame note missing from child accessibility tree: " +
            inner.pageContent?.slice(0, 800),
        );
        await json("chrome_fill_or_select", {
          tabId,
          ref,
          value,
          background: true,
        });
      },
      startCapture: (tabId, needResponseBody) =>
        json("chrome_network_capture", {
          action: "start",
          tabId,
          background: true,
          needResponseBody,
        }),
      async finishCapture(tabId) {
        return (await json("chrome_network_capture", { action: "stop", tabId }))
          .requests;
      },
      async bookmarks(folderPath) {
        return (
          await json("chrome_bookmark_search", { folderPath })
        ).bookmarks.map((b) => b.url);
      },
    };
  }

  async function uid(pageId, label, role) {
    const { data } = await call("take_snapshot", { pageId });
    const nodes = [data.snapshot];
    while (nodes.length) {
      const node = nodes.pop();
      if (node.name === label && node.role === role && node.id) return node.id;
      nodes.push(...(node.children ?? []));
    }
    throw new Error(label + " missing from accessibility snapshot");
  }
  return {
    async pages() {
      return (await call("list_pages", {})).data.pages;
    },
    async prepareMark(pageId, _selector, label) {
      const control = await uid(pageId, label, "button");
      return (signal) => call("click", { pageId, uid: control }, signal);
    },
    async mark(pageId, selector, label, signal) {
      const click = await this.prepareMark(pageId, selector, label);
      await click(signal);
    },
    async script(pageId, code) {
      const { text } = await call("evaluate_script", {
        pageId,
        function: "async () => {" + code + "}",
        waitForStableDom: false,
      });
      return JSON.parse(text.match(/```json\s*([\s\S]*?)\s*```/)?.[1]);
    },
    async childFill(pageId, value) {
      await call("fill", {
        pageId,
        uid: await uid(pageId, "Frame note", "textbox"),
        value,
      });
    },
    // DevTools retains network events automatically once attached.
    async startCapture() {},
    async finishCapture(pageId) {
      return (
        await call("list_network_requests", {
          pageId,
          resourceTypes: ["fetch"],
        })
      ).data.networkRequests;
    },
    async bookmarks() {
      throw new Unsupported(
        "No bookmark-folder tool in the Chrome DevTools MCP catalog",
      );
    },
  };
}
