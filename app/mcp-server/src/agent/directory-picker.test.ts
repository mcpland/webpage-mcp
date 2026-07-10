import { describe, expect, it, vi } from "vitest";

import {
  openDirectoryPicker,
  type DirectoryPickerCommandOptions,
  type DirectoryPickerRunner,
} from "./directory-picker";

interface RunnerCall {
  executable: string;
  args: readonly string[];
  options: DirectoryPickerCommandOptions;
}

function recordingRunner(
  implementation: (
    call: RunnerCall,
    callIndex: number,
  ) => Promise<{ stdout: string; stderr: string }>,
): { calls: RunnerCall[]; runner: DirectoryPickerRunner } {
  const calls: RunnerCall[] = [];
  const runner: DirectoryPickerRunner = async (executable, args, options) => {
    const call = { executable, args, options };
    calls.push(call);
    return implementation(call, calls.length - 1);
  };
  return { calls, runner };
}

function processError(properties: Record<string, unknown>): Error {
  return Object.assign(new Error("picker process failed"), properties);
}

describe("openDirectoryPicker", () => {
  it("passes a hostile macOS title as argv outside the static AppleScript", async () => {
    const title = 'Choose " & do shell script "touch /tmp/picker-pwned" & "';
    const { calls, runner } = recordingRunner(async () => ({
      stdout: "/tmp/safe-project\n",
      stderr: "",
    }));

    const result = await openDirectoryPicker(title, {
      platform: "darwin",
      runner,
    });

    expect(result).toEqual({ success: true, path: "/tmp/safe-project" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.executable).toBe("osascript");
    expect(calls[0]?.args).toEqual(["-e", expect.any(String), "--", title]);
    expect(calls[0]?.args[1]).not.toContain(title);
    expect(calls[0]?.options).toMatchObject({
      timeout: 60_000,
      maxBuffer: 16 * 1024,
      shell: false,
    });
  });

  it("passes a hostile Windows title only through the child environment", async () => {
    const title = 'Choose"; Start-Process calc; # $(touch /tmp/picker-pwned)';
    const { calls, runner } = recordingRunner(async () => ({
      stdout: "C:\\safe-project\r\n",
      stderr: "",
    }));

    const result = await openDirectoryPicker(title, {
      platform: "win32",
      runner,
    });

    expect(result).toEqual({ success: true, path: "C:\\safe-project" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.executable).toBe("powershell.exe");
    expect(calls[0]?.args).toEqual([
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-STA",
      "-Command",
      expect.any(String),
    ]);
    expect(calls[0]?.args.join("\n")).not.toContain(title);
    expect(calls[0]?.options.env?.WEBPAGE_MCP_DIRECTORY_PICKER_TITLE).toBe(
      title,
    );
    expect(calls[0]?.options.shell).toBe(false);
  });

  it("passes a hostile Linux title as one zenity argument without a shell", async () => {
    const title = '$(touch /tmp/picker-pwned)"; rm -rf /; #';
    const { calls, runner } = recordingRunner(async () => ({
      stdout: "/tmp/safe-project\n",
      stderr: "",
    }));

    const result = await openDirectoryPicker(title, {
      platform: "linux",
      runner,
    });

    expect(result).toEqual({ success: true, path: "/tmp/safe-project" });
    expect(calls).toEqual([
      {
        executable: "zenity",
        args: ["--file-selection", "--directory", "--title", title],
        options: expect.objectContaining({
          timeout: 60_000,
          maxBuffer: 16 * 1024,
          shell: false,
        }),
      },
    ]);
  });

  it("falls back to kdialog with argument arrays when zenity is unavailable", async () => {
    const title = "$(touch /tmp/picker-pwned)";
    const { calls, runner } = recordingRunner(async (_call, callIndex) => {
      if (callIndex === 0) {
        throw processError({ code: "ENOENT" });
      }
      return { stdout: "/home/test/project\n", stderr: "" };
    });

    const result = await openDirectoryPicker(title, {
      platform: "linux",
      homeDirectory: "/home/test",
      runner,
    });

    expect(result).toEqual({ success: true, path: "/home/test/project" });
    expect(calls[1]).toMatchObject({
      executable: "kdialog",
      args: ["--getexistingdirectory", "/home/test", "--title", title],
      options: { shell: false },
    });
  });

  it("rejects an oversized raw title before trimming or launching a process", async () => {
    const runner = vi.fn<DirectoryPickerRunner>();

    const result = await openDirectoryPicker(" ".repeat(257), {
      platform: "darwin",
      runner,
    });

    expect(result).toEqual({
      success: false,
      error: "Dialog title exceeds 256 UTF-8 bytes",
    });
    expect(runner).not.toHaveBeenCalled();
  });

  it("measures multibyte titles by UTF-8 bytes", async () => {
    const runner = vi.fn<DirectoryPickerRunner>();

    const result = await openDirectoryPicker("界".repeat(86), {
      platform: "darwin",
      runner,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("256 UTF-8 bytes");
    expect(runner).not.toHaveBeenCalled();
  });

  it("rejects a selected path beyond the output path budget", async () => {
    const { runner } = recordingRunner(async () => ({
      stdout: `${"/".repeat(4 * 1024 + 1)}\n`,
      stderr: "",
    }));

    const result = await openDirectoryPicker("Choose", {
      platform: "darwin",
      runner,
    });

    expect(result).toEqual({
      success: false,
      error: "Selected directory path exceeds 4096 UTF-8 bytes",
    });
  });

  it("rejects runner output beyond the configured stdio budget", async () => {
    const { runner } = recordingRunner(async () => ({
      stdout: "x".repeat(16 * 1024 + 1),
      stderr: "",
    }));

    const result = await openDirectoryPicker("Choose", {
      platform: "win32",
      runner,
    });

    expect(result).toEqual({
      success: false,
      error: "Directory picker output exceeded the safe limit",
    });
  });

  it.each(["darwin", "linux"] as const)(
    "preserves code 1 cancellation semantics on %s",
    async (platform) => {
      const { calls, runner } = recordingRunner(async () => {
        throw processError({ code: 1 });
      });

      const result = await openDirectoryPicker("Choose", { platform, runner });

      expect(result).toEqual({ success: false, cancelled: true });
      expect(calls).toHaveLength(1);
    },
  );

  it("treats an empty successful Windows selection as cancellation", async () => {
    const { runner } = recordingRunner(async () => ({
      stdout: " \r\n",
      stderr: "",
    }));

    const result = await openDirectoryPicker("Choose", {
      platform: "win32",
      runner,
    });

    expect(result).toEqual({ success: false, cancelled: true });
  });

  it("reports timeout without attempting a Linux fallback", async () => {
    const { calls, runner } = recordingRunner(async () => {
      throw processError({ killed: true, signal: "SIGTERM" });
    });

    const result = await openDirectoryPicker("Choose", {
      platform: "linux",
      runner,
    });

    expect(result).toEqual({ success: false, error: "Dialog timed out" });
    expect(calls).toHaveLength(1);
  });

  it("bounds unexpected process error messages returned to the caller", async () => {
    const { runner } = recordingRunner(async () => {
      throw new Error("x".repeat(4 * 1024));
    });

    const result = await openDirectoryPicker("Choose", {
      platform: "darwin",
      runner,
    });

    expect(result.success).toBe(false);
    expect(Buffer.byteLength(result.error ?? "", "utf8")).toBeLessThanOrEqual(
      2 * 1024,
    );
  });
});
