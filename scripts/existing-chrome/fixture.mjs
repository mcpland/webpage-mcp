// Privileged Chrome access here belongs to the test operator. Adapters receive
// fixture URLs and task inputs only; they discover all target IDs over MCP.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { startFixtureServer } from "../browser-e2e/fixtures.mjs";
import { cdpConnect, waitFor } from "../browser-e2e/harness.mjs";

export async function startSites() {
  const session = randomUUID();
  const markers = { a: randomUUID(), b: randomUUID() };
  const requestPath = "/check/" + randomUUID();
  let held;
  const fixture = await startFixtureServer((req, res, url) => {
    const path = url.pathname;
    const send = (status, body) =>
      res
        .writeHead(status, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        })
        .end(body);
    if (path === "/login") {
      res
        .writeHead(302, {
          location: url.search === "?b" ? "/b" : "/a",
          "set-cookie":
            "session=" + session + "; HttpOnly; SameSite=Lax; Path=/",
        })
        .end();
    } else if (path === "/hold") {
      held = res;
      res.on("close", () => {
        if (held === res) held = undefined;
      });
    } else if (path === requestPath) {
      const isJson = url.searchParams.get("format") === "json";
      res
        .writeHead(503, {
          "content-type": isJson ? "application/json" : "text/html",
          "cache-control": "no-store",
        })
        .end(
          isJson
            ? JSON.stringify({ status: "maintenance" })
            : "<h1>Maintenance</h1>",
        );
    } else if (
      path === "/a" ||
      path === "/b" ||
      path === "/guard" ||
      path === "/child"
    ) {
      const site = path.slice(1);
      if (
        ["a", "b"].includes(site) &&
        !req.headers.cookie?.split("; ").includes("session=" + session)
      ) {
        send(401, "Sign in first");
        return true;
      }
      const port = req.socket.localPort;
      const otherHost = req.headers.host.startsWith("localhost:")
        ? "127.0.0.1"
        : "localhost";
      send(
        200,
        `<!doctype html><title>Operations dashboard</title>
        <p id="marker">${markers[site] ?? "Frame"}</p>
        ${
          site === "child"
            ? ""
            : `<button id="mark" onclick="log('mark')">Mark item</button>
        <button id="check-html" onclick="check('html')">Check gateway</button>
        <button id="check-json" onclick="check('json')">Check API</button>`
        }
        <label>${site === "child" ? "Frame note" : "Main note"}<input oninput="log('input',this.value)"></label>
        ${site === "a" ? '<iframe title="Editor" src="http://' + otherHost + ":" + port + '/child"></iframe>' : ""}
        <script>async function check(format){
          const url=new URL('${requestPath}',location.origin);
          url.searchParams.set('format',format);url.searchParams.set('attempt',crypto.randomUUID());
          const response=await fetch(url);log('checked',{url:url.href,status:response.status});
        }
        function log(type,data){fetch('/log',{method:'POST',body:JSON.stringify({page:location.pathname,type,data})})}</script>`,
      );
    } else {
      return false;
    }
    return true;
  });
  const secondary = fixture.base.replace("127.0.0.1", "localhost");
  return {
    ...fixture,
    markers,
    a: fixture.base + "/a",
    b: secondary + "/b",
    holding: () => Boolean(held),
    release: () => held?.end("continue"),
  };
}

export async function seedChrome(port, extensionId, sites) {
  const targets = await waitFor(async () =>
    (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(
      (target) =>
        target.type === "service_worker" &&
        target.url.startsWith("chrome-extension://" + extensionId + "/"),
    ),
  );
  assert.ok(
    targets,
    "benchmark observer requires the extension service worker",
  );
  const worker = await cdpConnect(targets.webSocketDebuggerUrl);
  const evaluate = async (fn, ...args) => {
    const evaluation = await worker.send("Runtime.evaluate", {
      expression: "(" + fn.toString() + ")(..." + JSON.stringify(args) + ")",
      awaitPromise: true,
      returnByValue: true,
    });
    if (evaluation.exceptionDetails)
      throw new Error(evaluation.exceptionDetails.exception?.description);
    return evaluation.result.value;
  };
  try {
    const { ids, folderPath } = await evaluate(
      async (a, b, base) => {
        const create = async (url) =>
          (await chrome.tabs.create({ url, active: false })).id;
        const folder = await chrome.bookmarks.create({
          title: "Benchmark sites",
        });
        await chrome.bookmarks.create({
          parentId: folder.id,
          title: "Alpha",
          url: a,
        });
        await chrome.bookmarks.create({
          parentId: folder.id,
          title: "Beta",
          url: b,
        });
        const ids = {
          a: await create(new URL("/login", a).href),
          b: await create(new URL("/login?b", b).href),
          guard: await create(base + "/guard"),
          reader: await create(base + "/form"),
          cancel: await create(base + "/cancel-captured-press"),
          closed: await create(base + "/guard?retired"),
        };
        globalThis.activationLog = [];
        chrome.tabs.onActivated.addListener(({ tabId }) =>
          globalThis.activationLog.push(tabId),
        );
        return {
          ids,
          folderPath:
            (await chrome.bookmarks.get(folder.parentId))[0].title +
            "/" +
            folder.title,
        };
      },
      sites.a,
      sites.b,
      sites.base,
    );
    assert.ok(
      await waitFor(() =>
        evaluate(
          async (ids, a) => {
            const tabs = await Promise.all(
              Object.values(ids).map((id) => chrome.tabs.get(id)),
            );
            return (
              tabs.every((tab) => tab.status === "complete") &&
              tabs[0].url === a &&
              tabs[1].url.endsWith("/b")
            );
          },
          ids,
          sites.a,
        ),
      ),
      "pre-existing fixture tabs loaded",
    );
    async function activate(id) {
      await evaluate(
        (id) => chrome.tabs.update(id, { active: true }).then(() => true),
        id,
      );
      assert.ok(
        await waitFor(() =>
          evaluate((id) => globalThis.activationLog.at(-1) === id, id),
        ),
      );
    }
    // Portal A was viewed before the client connects. B stays unopened in
    // the background so the two lifecycle states can be measured separately.
    await activate(ids.a);
    assert.ok(
      await evaluate(async (id) => {
        const [ack] = await chrome.scripting.executeScript({
          target: { tabId: id },
          func: () =>
            new Promise((resolve) =>
              requestAnimationFrame(() =>
                requestAnimationFrame(() => resolve(!document.hidden)),
              ),
            ),
        });
        return ack.result;
      }, ids.a),
      "portal A was painted in the foreground",
    );
    await activate(ids.guard);
    return {
      ids,
      folderPath,
      close: () => worker.close(),
      activate,
      reset: async (guard = ids.guard) => {
        await evaluate(
          (id) => chrome.tabs.update(id, { active: true }).then(() => true),
          guard,
        );
        assert.ok(
          await waitFor(() =>
            evaluate(async (id) => (await chrome.tabs.get(id)).active, guard),
          ),
        );
        await evaluate(() => {
          globalThis.activationLog.length = 0;
        });
      },
      activations: () => evaluate(() => globalThis.activationLog.slice()),
      remove: (id) =>
        evaluate((id) => chrome.tabs.remove(id).then(() => true), id),
    };
  } catch (error) {
    worker.close();
    throw error;
  }
}
