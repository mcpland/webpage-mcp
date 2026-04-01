import type { AgentProject } from 'webpage-mcp-shared';

export function sanitizeProjectForPublicRead(project: AgentProject): AgentProject {
  return {
    ...project,
    activeClaudeSessionId: undefined,
  };
}
