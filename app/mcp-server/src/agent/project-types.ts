/**
 * Re-export AgentProject from shared package and define local input types.
 */
import type { AgentCliPreference, AgentProject } from 'webpage-mcp-shared';

// Re-export for backward compatibility
export type { AgentProject };

export interface CreateOrUpdateProjectInput {
  id?: string;
  name: string;
  description?: string;
  rootPath: string;
  preferredCli?: AgentCliPreference;
  selectedModel?: string;
  /**
   * Whether to enable the local Webpage MCP Connector integration for this project.
   * Defaults to true when omitted.
   */
  enableWebpageMcp?: boolean;
  /**
   * If true, create the directory if it doesn't exist.
   * Should only be set after user confirmation.
   */
  allowCreate?: boolean;
}
