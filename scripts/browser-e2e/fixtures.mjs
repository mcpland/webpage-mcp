// Local fixture pages for the browser e2e suite. Pages report what happened
// to them by POSTing to /log, so the suite never attaches its own CDP client to
// page targets (that would collide with the extension's chrome.debugger use).
import http from "node:http";
import { setTimeout } from "node:timers";
import { URL } from "node:url";

const LOGGER = `<script>
  window.__log = (type, data) => {
    try {
      fetch("/log", {
        method: "POST",
        keepalive: true,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ page: location.pathname, type, data }),
      });
    } catch {}
  };
</script>`;

const page = (title, body, head = "") =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>${head}</head><body>${body}</body></html>`;

const PAGES = {
  "/simple": page(
    "Simple",
    `<h1>Example Domain</h1>
<p>This domain is for use in illustrative examples in documents.</p>
<p><a href="/form">More information...</a></p>`,
  ),

  "/cancel-captured-press": page(
    "Cancelled slider",
    `<button id="slider">Slider</button><output id="owner"></output><button id="next">Next</button>
<script>
  const slider = document.querySelector("#slider");
  const owner = document.querySelector("#owner");
  let dragging = false, committed = null, activations = 0;
  slider.onpointerdown = event => { dragging = true; owner.setPointerCapture(event.pointerId); };
  slider.onmousedown = () => {
    __log("pressed", {});
    const until = performance.now() + 1200;
    while (performance.now() < until) {} // Cancel while Chrome is awaiting the press acknowledgement.
  };
  owner.onpointerup = event => { dragging = false; committed = event.clientX; };
  owner.onpointercancel = () => { dragging = false; __log("cancelled", {}); };
  slider.onclick = () => { activations++; };
  document.querySelector("#next").onclick = () => __log("next", { dragging, committed, activations });
</script>`,
    LOGGER,
  ),

  "/nested": page(
    "Nested",
    `<div class="card"><div class="card-body"><div class="card-title"><div>Quarterly revenue report</div></div></div></div>
<div class="navbar"><div class="menu-wrapper"></div></div>
<ul><li><div><span>Item one</span></div></li><li><div><span>Item two</span></div></li></ul>
<script>window.secretToken = "do-not-show";</script>
<button>OK</button>`,
  ),

  "/long": page(
    "Long",
    `<h1>Top of page</h1>
<div style="height:4000px">spacer</div>
<button id="bottom-btn" onclick="__log('bottom-click', {})">Bottom Button</button>`,
    LOGGER,
  ),

  "/form": page(
    "Form",
    `<h1>Login</h1>
<form id="f" action="/submitted" method="get">
  <input id="name" name="name" value="hello" />
  <input id="email" name="email" placeholder="email" />
  <textarea id="bio" name="bio"></textarea>
  <button id="submit" type="submit">Sign in</button>
</form>
<script>
  const field = (id) => document.getElementById(id);
  document.getElementById("f").addEventListener("submit", (event) => {
    event.preventDefault();
    __log("submit", { name: field("name").value, email: field("email").value });
  });
</script>`,
    LOGGER,
  ),

  "/submit-focus-dialog": page(
    "Focus before submit",
    `<form onsubmit="event.preventDefault(); document.body.dataset.submitted = 'yes'">
      <input id="target" oninput="this.form.other.focus()"
        onfocus="if (this.value) alert('Refocusing field')" />
      <input name="other" />
      <button>Submit</button>
    </form>`,
  ),

  "/realform": page(
    "Search",
    `<form action="/submitted" method="get"><input id="q" name="q" /><button>Go</button></form>`,
  ),

  "/frames": page(
    "Frames",
    `<input id="main-input" placeholder="MAIN INPUT" />
<iframe id="child" src="/frame-child" style="width:400px;height:120px"></iframe>
<script>
  const input = document.getElementById("main-input");
  input.addEventListener("input", () => __log("main-input", { value: input.value }));
</script>`,
    LOGGER,
  ),

  "/sibling-frames": page("Siblings", '<iframe id="first" src="/frame-button"></iframe><iframe id="second" src="/frame-button"></iframe>'),
  "/frame-button": page("Button", '<button id="hit" onclick="this.textContent+=1">click</button>'),

  "/frame-child": page(
    "Child",
    `<input id="child-input" placeholder="CHILD INPUT" />
<script>
  const input = document.getElementById("child-input");
  input.addEventListener("input", () => __log("child-input", { value: input.value }));
</script>`,
    LOGGER,
  ),

  "/dialog": page(
    "Dialog",
    `<button id="del" onclick="__log('confirm-result', { ok: confirm('Delete item?') })">Delete</button>`,
    LOGGER,
  ),

  // A confirm whose handler opens an alert shortly after it is answered.
  "/dialog-chain": page(
    "Dialog chain",
    `<button id="chain" onclick="const ok = confirm('Delete item?'); setTimeout(() => { alert(ok ? 'Deleted' : 'Kept'); __log('chain-done', { ok }); }, 50)">Delete</button>`,
    LOGGER,
  ),

  "/download": page(
    "Download",
    `<a id="dl" href="/file.txt" download="report.txt">Download report</a>`,
  ),

  "/links": page(
    "Links",
    `<a id="same" href="/simple">Same tab</a>
<a id="blank" href="/simple?from=blank" target="_blank">New tab</a>
<button id="noop" onclick="this.textContent = 'clicked'">Nothing</button>`,
  ),

  "/submitted": page("Submitted", "<h1>Submitted</h1>"),

  // Fires one request the moment its script runs, then keeps polling.
  "/polling": page(
    "Polling",
    `<h1>Polling</h1>
<script>
  fetch("/api/ping?i=0");
  let i = 0;
  const timer = setInterval(() => {
    fetch("/api/ping?i=" + ++i);
    if (i >= 12) clearInterval(timer);
  }, 300);
</script>`,
  ),
};

export function startFixtureServer() {
  const logs = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://fixture");
    if (req.method === "POST" && url.pathname === "/log") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        try {
          logs.push(JSON.parse(body));
        } catch {
          // ignore malformed log lines
        }
        res.writeHead(204).end();
      });
      return;
    }
    if (url.pathname === "/slow") {
      // The navigation commits at once, but the content (and the load event)
      // only arrives after ~2s.
      res.writeHead(200, { "content-type": "text/html" });
      res.write(
        "<!doctype html><html><head><title>Slow</title></head><body><h1>Loading</h1>" +
          " ".repeat(2048),
      );
      setTimeout(
        () =>
          res.end('<button id="late-btn">Late Button</button></body></html>'),
        2000,
      );
      return;
    }
    if (url.pathname === "/file.txt") {
      res.writeHead(200, {
        "content-type": "text/plain",
        "content-disposition": 'attachment; filename="report.txt"',
      });
      res.end("hello report");
      return;
    }
    if (url.pathname === "/api/ping") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ pong: Number(url.searchParams.get("i")) }));
      return;
    }
    const html = PAGES[url.pathname];
    if (!html) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        base: `http://127.0.0.1:${port}`,
        logs,
        clearLogs: () => logs.splice(0, logs.length),
        close: () =>
          new Promise((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
}
