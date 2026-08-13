import assert from "node:assert/strict";
import test from "node:test";
import { deriveChromeExtensionId } from "./extension-public-key.mjs";
import { createBrowserNativeSmokeIdentity } from "./browser-native-smoke-identity.mjs";

test("browser native smoke identities contain only a public key and derived ID", () => {
  const identity = createBrowserNativeSmokeIdentity();
  assert.deepEqual(Object.keys(identity), ["extensionId", "encodedPublicKey"]);
  assert.match(identity.extensionId, /^[a-p]{32}$/);
  assert.equal(
    deriveChromeExtensionId(identity.encodedPublicKey),
    identity.extensionId,
  );
  assert.doesNotMatch(identity.encodedPublicKey, /PRIVATE|BEGIN|END/);
});
