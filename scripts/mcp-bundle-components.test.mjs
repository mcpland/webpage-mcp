import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import {
  parseMcpBundleComponents,
  verifyMcpBundleMetafile,
} from "./mcp-bundle-components.mjs";

async function createFixture(t, { version = "3.25.76", imports = [] } = {}) {
  const root = await mkdtemp(join(tmpdir(), "mcp-bundle-components-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectRoot = join(root, "app/mcp-server");
  const inputPath = join(root, "node_modules/zod/index.js");
  await mkdir(dirname(inputPath), { recursive: true });
  await mkdir(join(root, "scripts"), { recursive: true });
  await mkdir(join(projectRoot, "dist"), { recursive: true });
  await writeFile(
    join(root, "node_modules/zod/package.json"),
    `${JSON.stringify({ name: "zod", version }, null, 2)}\n`,
  );
  await writeFile(inputPath, "module.exports = {};\n");
  await writeFile(
    join(root, "scripts/mcp-bundle-components.json"),
    '{\n  "zod": "3.25.76"\n}\n',
  );
  const metafilePath = join(projectRoot, "dist/metafile-cjs.json");
  await writeFile(
    metafilePath,
    JSON.stringify({
      inputs: { "../../node_modules/zod/index.js": { bytes: 20 } },
      outputs: {
        "dist/index.js": {
          imports,
          inputs: {
            "../../node_modules/zod/index.js": { bytesInOutput: 20 },
          },
        },
      },
    }),
  );
  return { projectRoot, metafilePath };
}

test("bundle metafile binds emitted package versions and rejects externals", async (t) => {
  const valid = await createFixture(t);
  const verified = verifyMcpBundleMetafile(valid);
  assert.deepEqual([...verified.components], [["zod", "3.25.76"]]);

  const versionDrift = await createFixture(t, { version: "4.0.0" });
  assert.throws(
    () => verifyMcpBundleMetafile(versionDrift),
    /bundle component closure drifted/,
  );

  const external = await createFixture(t, {
    imports: [{ path: "zod", kind: "require-call", external: true }],
  });
  assert.throws(
    () => verifyMcpBundleMetafile(external),
    /leaves reviewed component external/,
  );
});

test("bundle component manifest requires canonical sorted exact versions", () => {
  assert.throws(
    () => parseMcpBundleComponents('{"zod":"^3.25.0"}\n'),
    /not canonical JSON|sorted exact packages/,
  );
  assert.throws(
    () =>
      parseMcpBundleComponents(
        '{\n  "zod": "3.25.76",\n  "ajv": "8.18.0"\n}\n',
      ),
    /sorted exact packages/,
  );
});
