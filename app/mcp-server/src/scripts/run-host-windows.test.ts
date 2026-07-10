import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const wrapperPath = join(process.cwd(), "src", "scripts", "run_host.bat");

describe("Windows native host wrapper source", () => {
  it("does not enable delayed expansion or reparse executable paths with call", async () => {
    const source = await readFile(wrapperPath, "utf8");

    expect(source).toContain("setlocal DisableDelayedExpansion");
    expect(source).not.toMatch(/enabledelayedexpansion/i);
    expect(source).not.toMatch(/^\s*call\s+/im);
    expect(source).not.toContain("echo Initial PATH: %PATH%");
  });
});

describe.skipIf(process.platform !== "win32")(
  "Windows native host wrapper",
  () => {
    it("treats metacharacters in inherited paths as data instead of cmd syntax", async () => {
      const root = await mkdtemp(join(tmpdir(), "webpage-mcp-! ^ & ( ) %-"));
      const scriptsDir = join(root, "scripts");
      const markerPath = join(root, "runner-finished.txt");

      try {
        await mkdir(scriptsDir, { recursive: true });
        await copyFile(wrapperPath, join(root, "run_host.bat"));
        await writeFile(
          join(root, "index.js"),
          "module.exports = {};\n",
          "utf8",
        );
        await writeFile(
          join(scriptsDir, "native-log-runner.js"),
          "require('node:fs').writeFileSync(process.env.RUN_HOST_TEST_MARKER, 'ok');\n",
          "utf8",
        );

        const inheritedPath = process.env.PATH ?? "";
        const result = spawnSync(
          process.env.ComSpec ?? "cmd.exe",
          ["/d", "/s", "/c", `"${join(root, "run_host.bat")}"`],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              LOCALAPPDATA: root,
              PATH: `${root}\\not-real & exit /b 77 & rem;${inheritedPath}`,
              RUN_HOST_TEST_MARKER: markerPath,
              WEBPAGE_MCP_NODE_PATH: process.execPath,
            },
            timeout: 30_000,
          },
        );

        expect(result.error).toBeUndefined();
        expect(result.status).toBe(0);
        await expect(readFile(markerPath, "utf8")).resolves.toBe("ok");

        const logDir = join(root, "webpage-mcp", "logs");
        const wrapperLogName = (await readdir(logDir)).find((name) =>
          name.startsWith("native_host_wrapper_windows_"),
        );
        expect(wrapperLogName).toBeDefined();
        const wrapperLog = await readFile(
          join(logDir, wrapperLogName!),
          "utf8",
        );
        expect(wrapperLog).not.toContain("exit /b 77");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  },
);
