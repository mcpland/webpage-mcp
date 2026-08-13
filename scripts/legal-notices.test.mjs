import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  loadReviewedLegalFiles,
  parseThirdPartyNoticeRows,
  readBoundedLegalSource,
  validateThirdPartyInventory,
  validateThirdPartyLicenseBundle,
  verifyCargoNoticeClosure,
  verifyRepositoryLegalNotices,
} from "./legal-notices.mjs";
import { parseReviewedInventory } from "./npm-license-inventory.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("legal metadata reads reject symlinks and oversized files before loading", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "legal-notices-bounds-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outside = join(root, "outside-secret");
  const linked = join(root, "linked-license");
  await writeFile(outside, "synthetic-secret");
  await symlink(outside, linked);
  await assert.rejects(
    readBoundedLegalSource(linked, "synthetic legal file", 32),
    /regular non-symlink file/,
  );

  const oversized = join(root, "oversized-license");
  await writeFile(oversized, Buffer.alloc(33));
  await assert.rejects(
    readBoundedLegalSource(oversized, "synthetic legal file", 32),
    /between 1 byte and 32 bytes/,
  );
});

test("Cargo notice closure rejects both missing and stale rows", () => {
  const cargoLockSource = `
[[package]]
name = "locked-component"
version = "1.2.3"

[[package]]
name = "simd-math"
version = "0.1.0"
`;
  const noticeRows = new Map([
    [
      "cargo:stale-component@9.9.9",
      { ecosystem: "cargo", name: "stale-component", version: "9.9.9" },
    ],
  ]);
  assert.throws(
    () => verifyCargoNoticeClosure({ cargoLockSource, noticeRows }),
    /missing=\[cargo:locked-component@1\.2\.3\], stale=\[cargo:stale-component@9\.9\.9\]/,
  );
});

test("reviewed legal notices match package metadata and vendored boundaries", async () => {
  const summaries = await verifyRepositoryLegalNotices({
    rootDir: REPOSITORY_ROOT,
  });
  for (const [artifactName, summary] of Object.entries(summaries)) {
    assert.ok(summary.componentCount > 0, `${artifactName} closure is empty`);
    assert.ok(
      summary.locallyVerified > 0,
      `${artifactName} did not verify any installed package evidence`,
    );
  }

  const [mcpLegal, extensionLegal] = await Promise.all([
    loadReviewedLegalFiles({ rootDir: REPOSITORY_ROOT, artifactName: "mcp" }),
    loadReviewedLegalFiles({
      rootDir: REPOSITORY_ROOT,
      artifactName: "extension",
    }),
  ]);
  const mcpInventory = parseReviewedInventory(mcpLegal.inventory, "mcp");
  const extensionInventory = parseReviewedInventory(
    extensionLegal.inventory,
    "extension",
  );
  assert.deepEqual(
    extensionInventory.firstPartyWorkspacePackages,
    new Set(["webpage-mcp-shared"]),
  );
  assert.equal(
    mcpInventory.components.has(
      "@anthropic-ai/claude-agent-sdk-win32-x64@0.3.231",
    ),
    true,
  );
  assert.equal(
    extensionInventory.components.has("@img/sharp-win32-ia32@0.35.3"),
    true,
  );

  const anthropic = mcpInventory.components.get(
    "@anthropic-ai/claude-agent-sdk@0.3.231",
  );
  assert.equal(anthropic.declaredLicense, "SEE LICENSE IN README.md");
  assert.equal(
    anthropic.concludedLicense,
    "LicenseRef-Anthropic-Legal-Agreements",
  );
  assert.deepEqual(anthropic.review, ["anthropic-non-spdx"]);
  assert.deepEqual(
    anthropic.licenseEvidence.map(({ path }) => path),
    ["LICENSE.md", "README.md"],
  );
  const anthropicPlatform = mcpInventory.components.get(
    "@anthropic-ai/claude-agent-sdk-linux-x64@0.3.231",
  );
  assert.equal(anthropicPlatform.declaredLicense, "SEE LICENSE IN LICENSE.md");
  assert.deepEqual(anthropicPlatform.review, ["anthropic-non-spdx"]);
  assert.equal(
    mcpInventory.components.get("@anthropic-ai/sdk@0.116.0").concludedLicense,
    "MIT",
  );
  assert.deepEqual(
    mcpInventory.components.get("standardwebhooks@1.0.0").review,
    ["metadata-license-only"],
  );
  assert.deepEqual(mcpInventory.components.get("drizzle-orm@0.45.2").review, [
    "metadata-license-only",
  ]);

  const flatbuffers = extensionInventory.components.get("flatbuffers@1.12.0");
  assert.equal(flatbuffers.concludedLicense, "Apache-2.0");
  assert.deepEqual(flatbuffers.review, ["see-license-resolution"]);
  for (const key of ["expand-template@2.0.3", "rc@1.2.8"]) {
    const component = mcpInventory.components.get(key);
    assert.equal(component.concludedLicense, "MIT");
    assert.deepEqual(component.review, ["or-license-selection"]);
  }
  assert.deepEqual(extensionInventory.components.get("elkjs@0.11.0").review, [
    "epl-source-availability",
  ]);
  assert.ok(
    extensionInventory.components
      .get("@img/sharp-libvips-linux-x64@1.3.2")
      .review.includes("sharp-lgpl-platform"),
  );
  assert.ok(
    extensionInventory.components
      .get("tslib@2.8.1")
      .review.includes("tslib-copyright-notice"),
  );
  assert.ok(
    extensionInventory.components
      .get("onnxruntime-web@1.14.0")
      .review.includes("onnx-excluded-build-input"),
  );
  assert.ok(
    extensionInventory.components
      .get("onnxruntime-web@1.22.0")
      .review.includes("onnx-vendored-runtime"),
  );
  const transformers = extensionInventory.components.get(
    "@xenova/transformers@2.17.2",
  );
  assert.ok(transformers.review.includes("transformers-local-patch"));
  assert.deepEqual(transformers.patch, {
    path: "patches/@xenova__transformers@2.17.2.patch",
    sha256: "262aa63ab2e21aa2c33c033870e775e376dd0dbbc35a0d3d9e80be2c8b1293e2",
  });

  const tamperedInventory = JSON.parse(mcpLegal.inventory.toString("utf8"));
  tamperedInventory.components[0].packageJsonSha256 = "0".repeat(64);
  assert.throws(
    () =>
      validateThirdPartyInventory(
        Buffer.from(`${JSON.stringify(tamperedInventory, null, 2)}\n`),
        "mcp",
      ),
    /does not match the reviewed digest/,
  );

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
