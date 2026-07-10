import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  loadReviewedLegalFiles,
  parseThirdPartyNoticeRows,
  validateThirdPartyLicenseBundle,
  verifyRepositoryLegalNotices,
} from "./legal-notices.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("reviewed legal notices match package metadata and vendored boundaries", async () => {
  await verifyRepositoryLegalNotices({ rootDir: REPOSITORY_ROOT });

  const extensionNotice = await readFile(
    join(REPOSITORY_ROOT, "app/chrome-extension/public/THIRD_PARTY_NOTICES.md"),
    "utf8",
  );
  const rows = parseThirdPartyNoticeRows(extensionNotice, "extension");
  assert.equal(
    rows.get("npm:onnxruntime-web@1.22.0")?.distribution,
    "Vendored runtime files under `libs/` and `workers/`",
  );
  assert.equal(rows.has("npm:onnxruntime-web@1.14.0"), false);
  assert.equal(rows.has("npm:onnxruntime-common@1.14.0"), false);
  assert.equal(rows.has("npm:onnx-proto@4.0.4"), false);
  assert.equal(rows.get("npm:elkjs@0.11.0")?.license, "EPL-2.0");
  assert.equal(
    rows.get("npm:hnswlib-wasm-static@0.8.5")?.license,
    "Apache-2.0",
  );
  assert.equal(
    rows.get("vendored:Arc90 Readability@1.7.1")?.license,
    "Apache-2.0",
  );

  const extensionLegal = await loadReviewedLegalFiles({
    rootDir: REPOSITORY_ROOT,
    artifactName: "extension",
  });
  assert.ok(extensionLegal.thirdPartyLicenses);
  assert.equal(
    extensionLegal.archiveThirdPartyLicenses,
    "THIRD_PARTY_LICENSES.txt",
  );
  const tampered = Buffer.from(extensionLegal.thirdPartyLicenses);
  tampered[tampered.length - 1] ^= 1;
  assert.throws(
    () => validateThirdPartyLicenseBundle(tampered, "extension"),
    /does not match the reviewed digest/,
  );
});
