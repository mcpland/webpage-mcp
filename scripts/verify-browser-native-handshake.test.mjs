import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { validateBrowserNativeUserDataDirectory } from "./verify-browser-native-handshake.mjs";

const EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop";

async function createFixture(t, allowedExtensionId = EXTENSION_ID) {
  const runnerTemp = await mkdtemp(
    path.join(tmpdir(), "webpage-mcp-browser-profile-test-"),
  );
  t.after(() => rm(runnerTemp, { recursive: true, force: true }));
  const userDataDirectory = path.join(
    runnerTemp,
    "isolated-home",
    ".config",
    "google-chrome-for-testing",
  );
  const hostPath = path.join(runnerTemp, "run-host");
  const manifestDirectory = path.join(
    userDataDirectory,
    "NativeMessagingHosts",
  );
  await mkdir(manifestDirectory, { recursive: true });
  await writeFile(hostPath, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(hostPath, 0o755);
  await writeFile(
    path.join(manifestDirectory, "com.webpagemcp.nativehost.json"),
    `${JSON.stringify(
      {
        name: "com.webpagemcp.nativehost",
        path: hostPath,
        type: "stdio",
        allowed_origins: [`chrome-extension://${allowedExtensionId}/`],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return { runnerTemp, userDataDirectory };
}

test("browser handshake uses the registered Chrome for Testing profile", async (t) => {
  const fixture = await createFixture(t);
  assert.equal(
    await validateBrowserNativeUserDataDirectory({
      ...fixture,
      extensionId: EXTENSION_ID,
    }),
    await realpath(fixture.userDataDirectory),
  );
});

test("browser handshake rejects a profile outside RUNNER_TEMP", async (t) => {
  const inside = await createFixture(t);
  const outside = await createFixture(t);
  await assert.rejects(
    validateBrowserNativeUserDataDirectory({
      runnerTemp: inside.runnerTemp,
      userDataDirectory: outside.userDataDirectory,
      extensionId: EXTENSION_ID,
    }),
    /must stay beneath RUNNER_TEMP/,
  );
});

test("browser handshake rejects a manifest for another extension", async (t) => {
  const fixture = await createFixture(t, "ponmlkjihgfedcbaponmlkjihgfedcba");
  await assert.rejects(
    validateBrowserNativeUserDataDirectory({
      ...fixture,
      extensionId: EXTENSION_ID,
    }),
    /must allow the smoke extension/,
  );
});
