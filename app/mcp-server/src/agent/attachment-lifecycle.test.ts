import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentChatService } from "./chat-service";

const originalAllowedWorkspaceBase = process.env.MCP_ALLOWED_WORKSPACE_BASE;
const originalAgentDataDir = process.env.WEBPAGE_MCP_AGENT_DATA_DIR;
const originalAgentDbFile = process.env.WEBPAGE_MCP_AGENT_DB_FILE;
const tempDirs: string[] = [];

async function createTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function loadAgentModules() {
  vi.resetModules();
  const [{ upsertProject, deleteProject }, { attachmentService }, { dispatchAgentRpc }, { closeDb }] =
    await Promise.all([
      import("./project-service"),
      import("./attachment-service"),
      import("./rpc-dispatcher"),
      import("./db/client"),
    ]);

  return { upsertProject, deleteProject, attachmentService, dispatchAgentRpc, closeDb };
}

function createRpcDeps(): { chatService: AgentChatService } {
  return {
    chatService: {
      getEngineInfos: () => [],
    } as AgentChatService,
  };
}

afterEach(async () => {
  try {
    const { closeDb } = await import("./db/client");
    closeDb();
  } catch {
    // Ignore cleanup failures when the DB module was not initialized.
  }

  process.env.MCP_ALLOWED_WORKSPACE_BASE = originalAllowedWorkspaceBase;
  process.env.WEBPAGE_MCP_AGENT_DATA_DIR = originalAgentDataDir;
  process.env.WEBPAGE_MCP_AGENT_DB_FILE = originalAgentDbFile;
  vi.resetModules();

  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("project attachment lifecycle", () => {
  it("removes attachment files when deleting a project", async () => {
    const workspaceBase = await createTempDir("attachment-lifecycle-workspace-");
    const dataDir = await createTempDir("attachment-lifecycle-data-");
    const dbFile = path.join(dataDir, "agent.db");
    const projectRoot = path.join(workspaceBase, "project-root");
    await fs.mkdir(projectRoot, { recursive: true });

    process.env.MCP_ALLOWED_WORKSPACE_BASE = workspaceBase;
    process.env.WEBPAGE_MCP_AGENT_DATA_DIR = dataDir;
    process.env.WEBPAGE_MCP_AGENT_DB_FILE = dbFile;

    const { upsertProject, deleteProject, attachmentService } = await loadAgentModules();
    const project = await upsertProject({
      name: "Attachment Cleanup",
      rootPath: projectRoot,
      allowCreate: true,
    });

    const saved = await attachmentService.saveAttachment({
      projectId: project.id,
      messageId: "msg-1",
      index: 0,
      attachment: {
        type: "image",
        name: "demo.png",
        mimeType: "image/png",
        dataBase64: Buffer.from("png-data").toString("base64"),
      },
    });

    expect(await attachmentService.attachmentExists(project.id, saved.filename)).toBe(true);

    await deleteProject(project.id);

    expect(await attachmentService.attachmentExists(project.id, saved.filename)).toBe(false);
  });

  it("rejects attachment reads for deleted projects even if orphaned files still exist", async () => {
    const workspaceBase = await createTempDir("attachment-read-workspace-");
    const dataDir = await createTempDir("attachment-read-data-");
    const dbFile = path.join(dataDir, "agent.db");
    const projectRoot = path.join(workspaceBase, "project-root");
    await fs.mkdir(projectRoot, { recursive: true });

    process.env.MCP_ALLOWED_WORKSPACE_BASE = workspaceBase;
    process.env.WEBPAGE_MCP_AGENT_DATA_DIR = dataDir;
    process.env.WEBPAGE_MCP_AGENT_DB_FILE = dbFile;

    const { upsertProject, deleteProject, attachmentService, dispatchAgentRpc } =
      await loadAgentModules();
    const project = await upsertProject({
      name: "Attachment Read Guard",
      rootPath: projectRoot,
      allowCreate: true,
    });

    const saved = await attachmentService.saveAttachment({
      projectId: project.id,
      messageId: "msg-2",
      index: 0,
      attachment: {
        type: "image",
        name: "guard.png",
        mimeType: "image/png",
        dataBase64: Buffer.from("guard-data").toString("base64"),
      },
    });

    await deleteProject(project.id);

    const orphanPath = attachmentService.getAttachmentPath(project.id, saved.filename);
    await fs.mkdir(path.dirname(orphanPath), { recursive: true });
    await fs.writeFile(orphanPath, Buffer.from("orphan-data"));

    const response = await dispatchAgentRpc(
      {
        operation: "agent.attachments.get",
        params: {
          projectId: project.id,
          filename: saved.filename,
        },
      },
      createRpcDeps(),
    );

    expect(response.statusCode).toBe(404);
    expect(response.json).toEqual({ error: "Project not found" });
  });

  it("redacts attachment paths in stats and cleanup RPC responses", async () => {
    const workspaceBase = await createTempDir("attachment-stats-workspace-");
    const dataDir = await createTempDir("attachment-stats-data-");
    const dbFile = path.join(dataDir, "agent.db");
    const projectRoot = path.join(workspaceBase, "project-root");
    await fs.mkdir(projectRoot, { recursive: true });

    process.env.MCP_ALLOWED_WORKSPACE_BASE = workspaceBase;
    process.env.WEBPAGE_MCP_AGENT_DATA_DIR = dataDir;
    process.env.WEBPAGE_MCP_AGENT_DB_FILE = dbFile;

    const { upsertProject, attachmentService, dispatchAgentRpc } = await loadAgentModules();
    const project = await upsertProject({
      name: "Attachment Path Redaction",
      rootPath: projectRoot,
      allowCreate: true,
    });

    await attachmentService.saveAttachment({
      projectId: project.id,
      messageId: "msg-3",
      index: 0,
      attachment: {
        type: "image",
        name: "stats.png",
        mimeType: "image/png",
        dataBase64: Buffer.from("stats-data").toString("base64"),
      },
    });

    const statsResponse = await dispatchAgentRpc(
      {
        operation: "agent.attachments.stats",
      },
      createRpcDeps(),
    );

    expect(statsResponse.statusCode).toBe(200);
    expect(statsResponse.json?.pathRedacted).toBe(true);
    expect(statsResponse.json?.rootDir).toBe("attachments");
    expect(statsResponse.json?.projects?.[0]?.dirPath).toBe(`attachments/${project.id}`);

    const cleanupResponse = await dispatchAgentRpc(
      {
        operation: "agent.attachments.deleteByProject",
        params: { projectId: project.id },
      },
      createRpcDeps(),
    );

    expect(cleanupResponse.statusCode).toBe(200);
    expect(cleanupResponse.json?.pathRedacted).toBe(true);
    expect(cleanupResponse.json?.results?.[0]?.dirPath).toBe(`attachments/${project.id}`);
  });
});
