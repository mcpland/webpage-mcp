import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";

const originalAllowedWorkspaceBase = process.env.MCP_ALLOWED_WORKSPACE_BASE;
const originalUserProfile = process.env.USERPROFILE;
const tempDirs: string[] = [];

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function loadProjectService(allowedBase: string) {
  process.env.MCP_ALLOWED_WORKSPACE_BASE = allowedBase;
  process.env.USERPROFILE = allowedBase;
  vi.resetModules();
  vi.doMock("node:os", () => ({
    ...os,
    default: { ...os, homedir: () => allowedBase },
    homedir: () => allowedBase,
  }));
  return import("./project-service");
}

afterEach(async () => {
  process.env.MCP_ALLOWED_WORKSPACE_BASE = originalAllowedWorkspaceBase;
  if (originalUserProfile === undefined) {
    delete process.env.USERPROFILE;
  } else {
    process.env.USERPROFILE = originalUserProfile;
  }
  vi.doUnmock("node:os");
  vi.resetModules();

  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("validateRootPath", () => {
  it("accepts new project paths that stay inside the allowed workspace base", async () => {
    const allowedBase = await createTempDir("project-service-allowed-");
    const { validateRootPath } = await loadProjectService(allowedBase);
    const projectPath = path.join(allowedBase, "nested", "project");

    const result = await validateRootPath(projectPath);

    expect(result).toMatchObject({
      valid: true,
      absolute: projectPath,
      exists: false,
      needsCreation: true,
    });
  });

  it("rejects prefix-matching sibling paths outside the allowed workspace base", async () => {
    const allowedBase = await createTempDir("project-service-base-");
    const { validateRootPath } = await loadProjectService(allowedBase);
    const siblingPath = path.join(`${allowedBase}-evil`, "project");

    const result = await validateRootPath(siblingPath);

    expect(result.valid).toBe(false);
    expect(result.absolute).toBe(siblingPath);
    expect(result.error).toContain("allowed directories");
  });

  it("rejects paths that escape the allowed workspace base through a symlink", async () => {
    const allowedBase = await createTempDir("project-service-symlink-base-");
    const outsideBase = await createTempDir("project-service-symlink-outside-");
    const escapeLink = path.join(allowedBase, "escape");
    await mkdir(allowedBase, { recursive: true });
    await symlink(
      outsideBase,
      escapeLink,
      process.platform === "win32" ? "junction" : "dir",
    );

    const { validateRootPath } = await loadProjectService(allowedBase);
    const escapedProjectPath = path.join(escapeLink, "nested-project");

    const result = await validateRootPath(escapedProjectPath);

    expect(result.valid).toBe(false);
    expect(result.absolute).toBe(path.resolve(escapedProjectPath));
    expect(result.error).toContain("allowed directories");
  });
});
