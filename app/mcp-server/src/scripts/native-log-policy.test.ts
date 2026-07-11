import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BoundedLogFile,
  capExistingLogFile,
  consumeNativeLogPolicy,
  LOG_TRUNCATION_MARKER,
  NATIVE_LOG_ENV,
  pruneNativeHostLogs,
} from "./native-log-policy";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function makeTemporaryDirectory(): string {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "webpage-mcp-native-log-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

describe("native host log byte limits", () => {
  it("keeps ordinary stderr bytes unchanged", () => {
    const logPath = path.join(makeTemporaryDirectory(), "stderr.log");
    const writer = new BoundedLogFile(logPath, 256);
    writer.write("first line\n");
    writer.write(Buffer.from("second line\n"));
    writer.close();

    expect(fs.readFileSync(logPath, "utf8")).toBe("first line\nsecond line\n");
  });

  it("caps a process stderr file and records that bytes were discarded", () => {
    const logPath = path.join(makeTemporaryDirectory(), "stderr.log");
    const maximumBytes = 128;
    const writer = new BoundedLogFile(logPath, maximumBytes);
    writer.write(Buffer.alloc(maximumBytes, "a"));
    writer.write("overflow");
    writer.write(Buffer.alloc(1024, "b"));
    writer.close();

    const contents = fs.readFileSync(logPath);
    expect(contents).toHaveLength(maximumBytes);
    expect(contents.subarray(-LOG_TRUNCATION_MARKER.length)).toEqual(
      LOG_TRUNCATION_MARKER,
    );
  });

  it("caps the finite wrapper log before the native host starts", () => {
    const logPath = path.join(makeTemporaryDirectory(), "wrapper.log");
    fs.writeFileSync(logPath, Buffer.alloc(512, "w"));
    capExistingLogFile(logPath, 128);

    const contents = fs.readFileSync(logPath);
    expect(contents).toHaveLength(128);
    expect(contents.subarray(-LOG_TRUNCATION_MARKER.length)).toEqual(
      LOG_TRUNCATION_MARKER,
    );
  });
});

describe("native host log retention", () => {
  it("retains the current file and four newest prior files per log family", () => {
    const directory = makeTemporaryDirectory();
    const currentWrapper = path.join(
      directory,
      "native_host_wrapper_unix_current.log",
    );
    const currentStderr = path.join(
      directory,
      "native_host_stderr_unix_current.log",
    );
    fs.writeFileSync(currentWrapper, "current");
    fs.writeFileSync(currentStderr, "current");

    for (const family of ["wrapper", "stderr"]) {
      for (let index = 0; index < 8; index += 1) {
        const filePath = path.join(
          directory,
          `native_host_${family}_unix_${index}.log`,
        );
        fs.writeFileSync(filePath, String(index));
        const modified = new Date(1_700_000_000_000 + index * 1_000);
        fs.utimesSync(filePath, modified, modified);
      }
    }
    fs.symlinkSync(
      path.join(directory, "missing-target"),
      path.join(directory, "native_host_stderr_unix_symlink.log"),
    );

    pruneNativeHostLogs({
      wrapperPath: currentWrapper,
      stderrPath: currentStderr,
      wrapperMaxBytes: 1024,
      stderrMaxBytes: 1024,
      retentionCount: 5,
    });

    const logs = fs.readdirSync(directory).sort();
    for (const family of ["wrapper", "stderr"]) {
      expect(
        logs.filter(
          (name) =>
            name.startsWith(`native_host_${family}_`) &&
            !name.includes("symlink"),
        ),
      ).toEqual([
        `native_host_${family}_unix_4.log`,
        `native_host_${family}_unix_5.log`,
        `native_host_${family}_unix_6.log`,
        `native_host_${family}_unix_7.log`,
        `native_host_${family}_unix_current.log`,
      ]);
    }
    expect(logs).toContain("native_host_stderr_unix_symlink.log");
  });
});

describe("native host log bootstrap policy", () => {
  it("bounds configured values and removes internal variables from the child environment", () => {
    const environment: NodeJS.ProcessEnv = {
      [NATIVE_LOG_ENV.wrapperPath]: "/logs/wrapper.log",
      [NATIVE_LOG_ENV.stderrPath]: "/logs/stderr.log",
      [NATIVE_LOG_ENV.wrapperMaxBytes]: "999999999999",
      [NATIVE_LOG_ENV.stderrMaxBytes]: "not-a-number",
      [NATIVE_LOG_ENV.retentionCount]: "999999",
    };

    const policy = consumeNativeLogPolicy(environment);

    expect(policy.wrapperMaxBytes).toBe(64 * 1024 * 1024);
    expect(policy.stderrMaxBytes).toBe(8 * 1024 * 1024);
    expect(policy.retentionCount).toBe(100);
    for (const variableName of Object.values(NATIVE_LOG_ENV)) {
      expect(environment[variableName]).toBeUndefined();
    }
  });
});

describe("native host wrappers", () => {
  it.each(["run_host.sh", "run_host.bat"])(
    "%s launches through the bounded log supervisor without an unbounded stderr redirect",
    (fileName) => {
      const script = fs.readFileSync(path.join(__dirname, fileName), "utf8");
      expect(script).toContain("native-log-runner.js");
      expect(script).toContain("WEBPAGE_MCP_STDERR_LOG_MAX_BYTES");
      expect(script).toContain("WEBPAGE_MCP_LOG_RETENTION_COUNT");
      expect(script).not.toMatch(/2>>\s*["']?[%$][{(]?STDERR_LOG/);

      const baseUrlOutputLines = script
        .split(/\r?\n/)
        .filter(
          (line) =>
            line.includes("echo") && line.includes("ANTHROPIC_BASE_URL"),
        );
      expect(baseUrlOutputLines).toHaveLength(1);
      const normalizedBaseUrlOutput = baseUrlOutputLines[0]
        .replaceAll("^(", "(")
        .replaceAll("^)", ")");
      expect(normalizedBaseUrlOutput).toContain(
        "ANTHROPIC_BASE_URL is set (value hidden)",
      );
      expect(baseUrlOutputLines[0]).not.toContain("${ANTHROPIC_BASE_URL}");
      expect(baseUrlOutputLines[0]).not.toContain("%ANTHROPIC_BASE_URL%");
    },
  );
});
