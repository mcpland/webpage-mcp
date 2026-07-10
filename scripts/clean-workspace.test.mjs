import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { cleanWorkspace } from "./clean-workspace.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "webpage-mcp-clean-"));
  for (const directory of [
    "dist",
    ".turbo",
    "node_modules",
    "app/extension/dist",
    "app/extension/.turbo",
    "app/extension/node_modules",
    "packages/shared/dist",
    "packages/shared/node_modules",
  ]) {
    fs.mkdirSync(path.join(root, directory), { recursive: true });
  }
  return root;
}

test("cleanWorkspace removes build outputs without deleting dependencies", (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  cleanWorkspace(root, "dist");

  assert.equal(fs.existsSync(path.join(root, "dist")), false);
  assert.equal(fs.existsSync(path.join(root, "app/extension/dist")), false);
  assert.equal(fs.existsSync(path.join(root, "packages/shared/dist")), false);
  assert.equal(fs.existsSync(path.join(root, "node_modules")), true);
  assert.equal(
    fs.existsSync(path.join(root, "app/extension/node_modules")),
    true,
  );
});

test("cleanWorkspace removes workspace and root dependency directories", (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  cleanWorkspace(root, "modules");

  assert.equal(fs.existsSync(path.join(root, "node_modules")), false);
  assert.equal(
    fs.existsSync(path.join(root, "app/extension/node_modules")),
    false,
  );
  assert.equal(
    fs.existsSync(path.join(root, "packages/shared/node_modules")),
    false,
  );
  assert.equal(fs.existsSync(path.join(root, "app/extension/dist")), true);
});

test("cleanWorkspace rejects unknown targets", () => {
  assert.throws(
    () => cleanWorkspace("/tmp", "unknown"),
    /Unknown clean target/,
  );
});

test("workspace clean scripts and CI stay cross-platform", () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"),
  );
  const workflow = fs.readFileSync(
    path.join(repositoryRoot, ".github/workflows/ci.yml"),
    "utf8",
  );

  assert.equal(
    packageJson.scripts["clean:dist"],
    "node ./scripts/clean-workspace.mjs dist",
  );
  assert.equal(
    packageJson.scripts["clean:modules"],
    "node ./scripts/clean-workspace.mjs modules",
  );
  assert.match(workflow, /verify-windows:[\s\S]*?runs-on:\s*windows-latest/);
});
