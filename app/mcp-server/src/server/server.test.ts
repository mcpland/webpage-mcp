import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createSession, getSession } from "../agent/session-service";
import { getDb, projects } from "../agent/db";
import { Server } from "./index";

describe("Server agent RPC runtime", () => {
  const server = new Server({ instanceId: "unit-test" });
  const projectRoot = process.cwd();

  beforeAll(async () => {
    await server.start({
      sendRequestToExtensionAndWait: async () => ({ ok: true }),
    });
  });

  afterAll(async () => {
    await server.stop();
  });

  test("health.ping returns pong", async () => {
    const response = await server.invokeAgentRpc({ operation: "health.ping" });

    expect(response.statusCode).toBe(200);
    expect(response.json).toEqual({
      status: "ok",
      message: "pong",
    });
  });

  test("stop cancels active agent executions", async () => {
    const lifecycleServer = new Server({ instanceId: "lifecycle-test" });
    const chatService = (
      lifecycleServer as unknown as {
        agentChatService: { cancelAllExecutions(): number };
      }
    ).agentChatService;
    const cancelAllExecutions = vi.spyOn(chatService, "cancelAllExecutions");

    await lifecycleServer.start({
      sendRequestToExtensionAndWait: async () => ({ ok: true }),
    });
    await lifecycleServer.stop();

    expect(cancelAllExecutions).toHaveBeenCalledOnce();
  });

  test("agent.engines.list returns engines", async () => {
    const response = await server.invokeAgentRpc({
      operation: "agent.engines.list",
    });

    expect(response.statusCode).toBe(200);
    expect(
      (response.json as { engines?: Array<{ name: string }> }).engines,
    ).toEqual([
      { name: "codex", supportsMcp: false },
      { name: "claude", supportsMcp: true },
    ]);
  });

  test("extension.ask is no longer exposed as a public agent RPC", async () => {
    const response = await server.invokeAgentRpc({
      operation: "extension.ask",
      query: {
        tool: "chrome_inject_script",
      },
    });

    expect(response.statusCode).toBe(400);
    expect((response.json as { error?: string }).error).toContain(
      "Unsupported RPC operation",
    );
  });

  test("agent.projects.upsert rejects unsupported preferredCli values", async () => {
    const response = await server.invokeAgentRpc({
      operation: "agent.projects.upsert",
      body: {
        name: "Unsupported CLI Project",
        rootPath: projectRoot,
        preferredCli: "cursor",
      },
    });

    expect(response.statusCode).toBe(400);
    expect((response.json as { error?: string }).error).toBe(
      "Invalid preferredCli. Must be one of: codex, claude",
    );
  });

  test("agent.projects.sessions.create rejects unsupported engine names", async () => {
    const projectResponse = await server.invokeAgentRpc({
      operation: "agent.projects.upsert",
      body: {
        name: "Session Creation Project",
        rootPath: projectRoot,
        preferredCli: "codex",
      },
    });
    const projectId = (projectResponse.json as { project?: { id?: string } })
      .project?.id;

    expect(projectResponse.statusCode).toBe(200);
    expect(projectId).toBeTruthy();

    const response = await server.invokeAgentRpc({
      operation: "agent.projects.sessions.create",
      params: { projectId },
      body: {
        engineName: "cursor",
      },
    });

    expect(response.statusCode).toBe(400);
    expect((response.json as { error?: string }).error).toBe(
      "Invalid engineName. Must be one of: codex, claude",
    );
  });

  test("agent.chat.act self-heals legacy sessions with unsupported engine names", async () => {
    const projectResponse = await server.invokeAgentRpc({
      operation: "agent.projects.upsert",
      body: {
        name: "Legacy Session Recovery Project",
        rootPath: projectRoot,
        preferredCli: "codex",
      },
    });
    const projectId = (projectResponse.json as { project?: { id?: string } })
      .project?.id;

    expect(projectResponse.statusCode).toBe(200);
    expect(projectId).toBeTruthy();

    const legacySession = await createSession(projectId!, "cursor" as any, {
      name: "Legacy Cursor Session",
    });

    const response = await server.invokeAgentRpc({
      operation: "agent.chat.act",
      params: { sessionId: legacySession.id },
      body: {
        instruction: "Say hello",
        dbSessionId: legacySession.id,
      },
    });

    expect(response.statusCode).toBe(200);
    expect((response.json as { status?: string }).status).toBe("accepted");

    const healedSession = await getSession(legacySession.id);
    expect(healedSession?.engineName).toBe("codex");
  });

  test("agent.chat.act rejects mismatched session identifiers", async () => {
    const projectResponse = await server.invokeAgentRpc({
      operation: "agent.projects.upsert",
      body: {
        name: "Session Validation Project",
        rootPath: projectRoot,
        preferredCli: "codex",
      },
    });
    const projectId = (projectResponse.json as { project?: { id?: string } })
      .project?.id;

    expect(projectResponse.statusCode).toBe(200);
    expect(projectId).toBeTruthy();

    const session = await createSession(projectId!, "codex");

    const response = await server.invokeAgentRpc({
      operation: "agent.chat.act",
      params: { sessionId: session.id },
      body: {
        instruction: "Say hello",
        dbSessionId: "different-session-id",
      },
    });

    expect(response.statusCode).toBe(400);
    expect((response.json as { error?: string }).error).toBe(
      "dbSessionId must match the sessionId path parameter",
    );
  });

  test("agent.projects.list sanitizes legacy preferredCli values that are no longer supported", async () => {
    const now = new Date().toISOString();
    const activeClaudeSessionId = `legacy-claude-session-${Date.now()}`;
    await getDb()
      .insert(projects)
      .values({
        id: `legacy-project-${Date.now()}`,
        name: "Legacy Preferred CLI Project",
        description: null,
        rootPath: projectRoot,
        preferredCli: "cursor",
        selectedModel: null,
        activeClaudeSessionId,
        enableWebpageMcp: "1",
        createdAt: now,
        updatedAt: now,
        lastActiveAt: now,
      });

    const response = await server.invokeAgentRpc({
      operation: "agent.projects.list",
    });

    expect(response.statusCode).toBe(200);
    const listedProjects =
      (
        response.json as {
          projects?: Array<{ id: string; preferredCli?: string; activeClaudeSessionId?: string }>;
        }
      ).projects ?? [];
    const legacyProject = listedProjects.find((project) =>
      project.id.startsWith("legacy-project-"),
    );
    expect(legacyProject).toBeTruthy();
    expect(legacyProject?.preferredCli).toBeUndefined();
    expect(legacyProject?.activeClaudeSessionId).toBeUndefined();
  });

  test("agent.projects.upsert redacts activeClaudeSessionId from public responses", async () => {
    const initialResponse = await server.invokeAgentRpc({
      operation: "agent.projects.upsert",
      body: {
        name: "Project Upsert Redaction",
        rootPath: projectRoot,
        preferredCli: "claude",
      },
    });

    expect(initialResponse.statusCode).toBe(200);
    const projectId = (initialResponse.json as { project?: { id?: string } }).project?.id;
    expect(projectId).toBeTruthy();

    const storedResumeId = `project-resume-${Date.now()}`;
    await getDb()
      .update(projects)
      .set({ activeClaudeSessionId: storedResumeId })
      .where(eq(projects.id, projectId as string));

    const response = await server.invokeAgentRpc({
      operation: "agent.projects.upsert",
      body: {
        id: projectId,
        name: "Project Upsert Redaction",
        rootPath: projectRoot,
        preferredCli: "claude",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(
      (response.json as { project?: { activeClaudeSessionId?: string } }).project
        ?.activeClaudeSessionId,
    ).toBeUndefined();
  });

  test("unsupported operation returns bad request", async () => {
    const response = await server.invokeAgentRpc({
      operation: "unknown.operation",
    });

    expect(response.statusCode).toBe(400);
    expect((response.json as { error?: string }).error).toContain(
      "Unsupported RPC operation",
    );
  });

  test("agent.chat.stream returns migration guidance", async () => {
    const response = await server.invokeAgentRpc({
      operation: "agent.chat.stream",
      params: { sessionId: "session-1" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json).toEqual({
      error:
        "Use agent_stream_subscribe over native messaging instead of chat.stream",
    });
  });
});
