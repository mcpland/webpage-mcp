# Controlling an existing Chrome session

This benchmark attaches an MCP client **after** Chrome has loaded two authenticated local sites, a bookmark folder, a cross-origin frame and several user tabs. It measures the public tools of each MCP server with a scripted driver. The page or Chrome supplies the verdict independently of the tool's success message.

## Run the benchmark

Use Node 24, the repository's pinned pnpm and Chrome for Testing on macOS or Linux. Install the workspace dependencies with `pnpm install --frozen-lockfile`. For a working-tree run, build the shared package, MCP server and extension first, then point `WEBPAGE_MCP_CHROME_BINARY` at the browser executable.

```sh
pnpm build:shared && pnpm build:mcp && pnpm build:extension
pnpm bench:existing-chrome --list
pnpm bench:existing-chrome --headful --repeat 5 --output /tmp/existing-chrome.json
node scripts/existing-chrome/summary.mjs /tmp/existing-chrome.json
```

Use `--tasks same-title,closed-target` to rerun selected tasks. The default is three profiles in headless mode with the webpage adapter. Use `--headful` to measure visible Chrome's actual tab lifecycle. The runner exits with status 1 on any failed task or infrastructure error. Expected baseline failures still produce the JSON report. Unsupported capabilities are recorded separately.

### Reproduce the published 0.11.0 run

From the repository root, use the following commands in a POSIX shell with `curl`, `unzip`, `npm` and `shasum` available. The two checksums identify the actual release archives. The Chrome binary used on Apple Silicon was [Chrome for Testing 153.0.8010.12](https://storage.googleapis.com/chrome-for-testing-public/153.0.8010.12/mac-arm64/chrome-mac-arm64.zip). Set `WEBPAGE_MCP_CHROME_BINARY` to its executable before starting. Headful Linux requires a display.

```sh
(
  set -eu
  assets=$(mktemp -d)
  curl -fsSL https://github.com/mcpland/webpage-mcp/releases/download/v0.11.0/webpage-mcp-connector-0.11.0-chrome-extension.zip -o "$assets/extension.zip"
  curl -fsSL https://registry.npmjs.org/webpage-mcp/-/webpage-mcp-0.11.0.tgz -o "$assets/server.tgz"
  (cd "$assets" && shasum -a 256 -c <<'SUMS'
75f8e8e1c87af1f57a43bac1a9536b734a68b865ffb353dd1fd4e14ecfcfaf7d  extension.zip
fd86c10447d87537b98d13816a156ec215c666df474d8bec235e6029c50f2db9  server.tgz
SUMS
  )
  unzip -q "$assets/extension.zip" -d "$assets/ext"
  npm install --prefix "$assets/consumer" --ignore-scripts --no-save --no-audit --no-fund "$assets/server.tgz" chrome-devtools-mcp@1.13.0
  export BENCH_EXTENSION_DIR="$assets/ext"
  export BENCH_SERVER_DIR="$assets/consumer/node_modules/webpage-mcp"
  export BENCH_DEVTOOLS_DIR="$assets/consumer/node_modules/chrome-devtools-mcp"
  pnpm bench:existing-chrome --adapters webpage,devtools --headful --repeat 5 --output /tmp/existing-chrome.json
)
node scripts/existing-chrome/summary.mjs /tmp/existing-chrome.json
```

### What the runner measures

Each adapter and repetition gets a fresh temporary browser profile, native host, socket and HTTP session cookies. The shared harness changes the test copy's extension key to register a disposable native host. Even in the DevTools arm the same extension is present for setup and observation. The DevTools adapter attaches through its own `--browser-url` transport. Neither adapter is given Chrome's fixture tab IDs or the random text that proves the session was read.

| Task                                         | Independent success condition                                                                                                                                                                               |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `same-title`                                 | Discover two existing tabs with identical titles. Click the requested URL's button while the user's guard tab stays active. The target was previously painted in the foreground.                            |
| `never-active-tab`                           | Click the other dashboard, which finished loading in the background and has never been activated. Its page must report the click.                                                                           |
| `mid-read-switch`                            | A server barrier holds an MCP read in flight. The operator switches tabs before the server releases it. The returned random marker must still belong to the original signed-in site.                        |
| `cross-origin-frame`                         | Discover the editable control via its accessibility reference and fill the child frame on a different origin. The child must report the intended value.                                                     |
| `action-network-json`, `action-network-html` | Click on the foreground dashboard and recover the exact, uniquely identified HTTP 503 response with its status through the adapter's default network tools. The API sends JSON or an HTML maintenance page. |
| `action-network-html-detailed`               | Repeat the HTML task using Webpage MCP's CDP response-body capture option. DevTools uses its ordinary network request list. Both are scored on identifying the request and status.                          |
| `cancel-press`                               | Cancel an in-flight MCP request after the page receives the press. Wait past the page's input handler, then independently check that dragging ended, no release was committed and no click handler ran.     |
| `bookmark-portals`                           | Find both bookmarks using the full, localized folder path. Reuse each already-open, signed-in tab and read its per-session marker.                                                                          |
| `bookmark-short-name`                        | Resolve the same uniquely named folder directly by its visible name, without a built-in folder prefix. This tests the folder lookup operation specifically.                                                 |
| `closed-target`                              | Discover a button, let the operator close its tab, then issue the click using the old handle. The tool must reject the request, and the same button in the foreground must receive no click.                |

The JSON records every measured tool call, including cancellations and errors, elapsed time, page events, wrong-target writes and unexpected Chrome tab activations. One operator-induced switch is allowed in `mid-read-switch`. Timing starts after fixture setup and includes evidence waits. The summary reports median calls and elapsed time for passing samples. Connection, tool discovery and the operator's private setup/probes are excluded. Synthetic guard tabs witness wrong writes for the instrumented actions. OS focus, multi-window switching, live websites, installation success, token use and a model's choice of tool are outside this measurement. The adapters here cover Webpage MCP and Chrome DevTools MCP. The public task definitions and independent oracles can also be used to implement additional drivers.

## Published baseline

See the [raw 0.11.0 baseline](existing-chrome-0.11.0.json) for the browser build, host, tested entry-point hashes, every trial and errors.

On November 24, 2026 (Shanghai), the two adapters each ran the 11 tasks five times using visible Chrome 153.0.8010.12 on macOS arm64 and Node 24.16.0. All ten isolated profiles initialized. There were zero unexpected Chrome tab activations in the 110 trials. One scenario recorded wrong-target writes despite the active tab remaining unchanged.

| Tested path                                            |             Webpage MCP 0.11.0 |     Chrome DevTools MCP 1.13.0 |
| ------------------------------------------------------ | -----------------------------: | -----------------------------: |
| Previously viewed background tab, duplicate title      |                 5/5 · 5,356 ms |                   5/5 · 449 ms |
| Loaded background tab that had never been active       |                            0/5 |                   5/5 · 346 ms |
| User switches tabs during authenticated read           |                            5/5 |                            5/5 |
| Fill a cross-origin frame via accessibility reference  |                            5/5 |                            0/5 |
| Click and identify JSON HTTP 503                       |                            5/5 |                            5/5 |
| Click and identify HTML HTTP 503, default capture      |                            0/5 |                            5/5 |
| Same HTML response, detailed capture                   |                            5/5 |                            5/5 |
| Cancel a press without committing it                   |                            5/5 |                            0/5 |
| Full bookmark folder path to two authenticated portals |                            5/5 |                    Unsupported |
| Same folder by its unique short name                   |                            0/5 |                    Unsupported |
| Reject click after user closes the target              | 0/5 · five wrong-target clicks | 5/5 · zero wrong-target clicks |

### Priorities suggested by the baseline

1. **Reject a disappeared explicit target before dispatch.** In all five trials Chrome delivered the click to the foreground guard page after the requested tab was closed. The tool returned without an error. The click handler falls back to the active tab after a lookup miss. Preserve active-tab selection for requests that omit a target. Add the same closed-target contract to other mutating tools before treating them as covered. [Click target resolution in 0.11.0](https://github.com/mcpland/webpage-mcp/blob/v0.11.0/app/chrome-extension/entrypoints/background/tools/browser/interaction.ts#L455-L459)
2. **Make background clicks reliable and observable.** With the never-active target, the click call returned without an error after roughly 5.35 seconds. No target click reached the fixture within the following five seconds. On the previously viewed target every click succeeded, but a whole task still took a median 5.36 seconds versus 0.45 seconds for DevTools. Keep both lifecycle cases as acceptance tests and measure input dispatch separately from acknowledgement before choosing a fix.
3. **Preserve failed requests in ordinary network diagnostics.** The same API operation was visible with a JSON 503. The default webRequest backend omitted the HTML 503 in every trial. CDP detailed capture identified it in every trial. The default backend's MIME filter excludes some text responses. Prefer preserving failure metadata even when response bodies or static resources are omitted. [MIME filtering in 0.11.0](https://github.com/mcpland/webpage-mcp/blob/v0.11.0/app/chrome-extension/entrypoints/background/tools/browser/network-capture-web-request.ts#L305-L328)
4. **Resolve unambiguous bookmark folder names.** Webpage MCP read both real bookmark entries and authenticated page markers with the full path. All five direct lookups using just the visible folder name failed. A unique-name lookup with disambiguation for duplicate names would make this native capability easier for clients to use. [Folder path resolution in 0.11.0](https://github.com/mcpland/webpage-mcp/blob/v0.11.0/app/chrome-extension/entrypoints/background/tools/browser/bookmark.ts#L140-L184)

The cancellation scenario also passed five isolated Webpage MCP reruns. An earlier headful calibration run, before the final startup sequence was in place, left the fixture in a dragging state once. The formal result covers the recorded timing and does not establish cancellation reliability for every focus transition.

The DevTools adapter's cross-origin fill returned an element-handle error in the chosen accessibility snapshot/fill path. Its cancellation trials still committed the release after the caller cancelled. Its normal tool catalog did not expose bookmark-folder lookup. Each result describes this version, adapter path, fixture and Chrome build. The raw counts are intended for regression tracking; they do not establish a market ranking.
