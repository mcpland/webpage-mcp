// @vitest-environment node

import { describe, expect, it } from "vitest";
import extensionConfig from "../../wxt.config";

describe("extension manifest resource exposure", () => {
  it("keeps internal models, workers, and injected helpers inaccessible to web pages", () => {
    const manifest = extensionConfig.manifest as {
      web_accessible_resources?: unknown;
    };

    // These resources are loaded by extension contexts or chrome.scripting.
    // Neither path requires web_accessible_resources, which would also let
    // arbitrary sites probe the stable extension ID and fetch the files.
    expect(manifest.web_accessible_resources).toBeUndefined();
  });
});
