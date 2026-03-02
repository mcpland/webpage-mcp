/**
 * Composable for managing Agent Projects.
 * Handles project CRUD, selection, and persistence.
 */
import { ref, computed } from '@/entrypoints/shared/reactivity';
import { getMessage } from '@/utils/i18n';
import type { AgentProject, AgentStoredMessage } from 'webpage-mcp-shared';
import { parseAgentRpcJson, requestAgentRpcFetch, requestAgentRpcJson } from '@/utils/agent-rpc';

const STORAGE_KEY_SELECTED_PROJECT = 'agent-selected-project-id';

interface PathValidationResult {
  valid: boolean;
  absolute: string;
  exists: boolean;
  needsCreation: boolean;
  error?: string;
}

/**
 * Normalize path for comparison (handle trailing slashes and separators).
 */
function normalizePathForComparison(path: string): string {
  // Remove trailing slashes and normalize separators
  return path
    .trim()
    .replace(/[/\\]+$/, '')
    .replace(/\\/g, '/')
    .toLowerCase();
}

export interface UseAgentProjectsOptions {
  ensureServer: () => Promise<boolean>;
  onHistoryLoaded?: (messages: AgentStoredMessage[]) => void;
}

export function useAgentProjects(options: UseAgentProjectsOptions) {
  const t = (key: string, fallback: string, substitutions?: string[]): string =>
    getMessage(key, substitutions, fallback);

  // State
  const projects = ref<AgentProject[]>([]);
  const selectedProjectId = ref<string>('');
  const isLoadingProjects = ref(false);
  const showCreateProject = ref(false);
  const newProjectName = ref('');
  const newProjectRootPath = ref('');
  const isCreatingProject = ref(false);
  const projectError = ref<string | null>(null);

  // Computed
  const selectedProject = computed(() => {
    return projects.value.find((p) => p.id === selectedProjectId.value) || null;
  });

  const canCreateProject = computed(() => {
    return newProjectName.value.trim().length > 0 && newProjectRootPath.value.trim().length > 0;
  });

  // Load selected project from storage
  async function loadSelectedProjectId(): Promise<void> {
    try {
      const result = await chrome.storage.local.get(STORAGE_KEY_SELECTED_PROJECT);
      if (result[STORAGE_KEY_SELECTED_PROJECT]) {
        selectedProjectId.value = result[STORAGE_KEY_SELECTED_PROJECT];
      }
    } catch (error) {
      console.error('Failed to load selected project ID:', error);
    }
  }

  // Save selected project to storage
  async function saveSelectedProjectId(): Promise<void> {
    try {
      await chrome.storage.local.set({
        [STORAGE_KEY_SELECTED_PROJECT]: selectedProjectId.value,
      });
    } catch (error) {
      console.error('Failed to save selected project ID:', error);
    }
  }

  // Fetch projects from server
  async function fetchProjects(): Promise<void> {
    isLoadingProjects.value = true;
    try {
      const data = await requestAgentRpcJson<{ projects?: AgentProject[] }>({
        operation: 'agent.projects.list',
      });
      projects.value = data.projects || [];
    } catch (error) {
      console.error('Failed to fetch projects:', error);
    } finally {
      isLoadingProjects.value = false;
    }
  }

  // Refresh projects
  async function refreshProjects(): Promise<void> {
    const ready = await options.ensureServer();
    if (!ready) return;
    await fetchProjects();
  }

  // Track pending history load with nonce to prevent A→B→A race conditions
  let historyLoadNonce = 0;

  /**
   * Load chat history for a project with race-condition protection.
   * Uses a nonce to handle A→B→A scenarios.
   */
  async function loadChatHistory(projectId: string): Promise<void> {
    if (!projectId) return;

    // Increment nonce - any subsequent load will invalidate this one
    const myNonce = ++historyLoadNonce;

    const isStillValid = (): boolean => {
      return myNonce === historyLoadNonce && selectedProjectId.value === projectId;
    };

    try {
      const result = await requestAgentRpcJson<{ data?: AgentStoredMessage[] }>({
        operation: 'agent.chat.messages.list',
        params: { projectId },
        query: { limit: 100 },
      });

      if (!isStillValid()) return;

      if (!isStillValid()) return;

      // Server returns { success, data: messages[], totalCount, pagination }
      const stored = result.data || [];
      options.onHistoryLoaded?.(stored);
    } catch (error) {
      console.error('Failed to load chat history:', error);
    }
  }

  // Validate path before creating project
  async function validatePath(rootPath: string): Promise<PathValidationResult | null> {
    try {
      return await requestAgentRpcJson<PathValidationResult>({
        operation: 'agent.projects.validatePath',
        body: { rootPath },
      });
    } catch (error) {
      console.error('Failed to validate path:', error);
      return null;
    }
  }

  // Create project
  async function createProject(): Promise<AgentProject | null> {
    const name = newProjectName.value.trim();
    const rootPath = newProjectRootPath.value.trim();
    if (!name || !rootPath) return null;

    const ready = await options.ensureServer();
    if (!ready) {
      projectError.value = 'Agent server is not available.';
      return null;
    }

    isCreatingProject.value = true;
    projectError.value = null;

    try {
      // Step 1: Validate the path
      const validation = await validatePath(rootPath);
      if (!validation) {
        projectError.value = t('agentProjectsValidateFailed', 'Failed to validate path');
        return null;
      }

      if (!validation.valid) {
        projectError.value = validation.error || t('agentProjectsInvalidPath', 'Invalid path');
        return null;
      }

      // Step 2: If directory doesn't exist, ask user for confirmation
      let allowCreate = false;
      if (validation.needsCreation) {
        const confirmed = confirm(
          t('agentProjectsConfirmCreateDir', 'The directory "{0}" does not exist. Create it?', [
            validation.absolute,
          ]),
        );
        if (!confirmed) {
          return null;
        }
        allowCreate = true;
      }

      // Step 3: Create the project
      const payload = await requestAgentRpcJson<{ project?: AgentProject }>({
        operation: 'agent.projects.upsert',
        body: { name, rootPath, allowCreate },
      });
      const project = payload?.project as AgentProject | undefined;

      if (project?.id) {
        // Update local state
        const others = projects.value.filter((p) => p.id !== project.id);
        projects.value = [...others, project];
        selectedProjectId.value = project.id;
        await saveSelectedProjectId();
        await loadChatHistory(project.id);

        // Clear form
        newProjectName.value = '';
        newProjectRootPath.value = '';
        showCreateProject.value = false;

        return project;
      } else {
        projectError.value = t(
          'agentProjectsInvalidCreateResponse',
          'Project created but response is invalid.',
        );
        return null;
      }
    } catch (error: unknown) {
      console.error('Failed to create project:', error);
      projectError.value =
        error instanceof Error
          ? error.message
          : t('agentProjectsCreateFailed', 'Failed to create project.');
      return null;
    } finally {
      isCreatingProject.value = false;
    }
  }

  // Toggle create project form
  function toggleCreateProject(): void {
    showCreateProject.value = !showCreateProject.value;
    if (!showCreateProject.value) {
      newProjectName.value = '';
      newProjectRootPath.value = '';
      projectError.value = null;
    }
  }

  // Get default project root path for a project name
  async function getDefaultProjectRoot(projectName: string): Promise<string | null> {
    if (!projectName.trim()) return null;

    try {
      const data = await requestAgentRpcJson<{ path?: string }>({
        operation: 'agent.projects.defaultRoot',
        body: { projectName: projectName.trim() },
      });
      return data.path || null;
    } catch (error) {
      console.error('Failed to get default project root:', error);
      return null;
    }
  }

  // Open directory picker dialog
  async function pickDirectory(): Promise<string | null> {
    const ready = await options.ensureServer();
    if (!ready) {
      projectError.value = t('agentProjectsServerUnavailable', 'Server not available');
      return null;
    }

    try {
      const response = await requestAgentRpcFetch({
        operation: 'agent.projects.pickDirectory',
      });
      const data = parseAgentRpcJson<{
        success?: boolean;
        path?: string;
        cancelled?: boolean;
        error?: string;
      }>(response);

      // Handle operation errors (e.g., old native build without this operation)
      if (!response.ok) {
        if (response.statusCode === 404) {
          projectError.value = t(
            'agentProjectsPickerUnavailable',
            'Directory picker not available. Please rebuild and restart the MCP server.',
          );
        } else {
          projectError.value = t('agentProjectsServerHttpError', 'Server error: {0}', [
            String(response.statusCode),
          ]);
        }
        return null;
      }

      if (data.success && data.path) {
        return data.path;
      } else if (data.cancelled) {
        return null; // User cancelled, not an error
      } else {
        projectError.value =
          data.error || t('agentProjectsPickerOpenFailed', 'Failed to open directory picker');
        return null;
      }
    } catch (error) {
      console.error('Failed to open directory picker:', error);
      projectError.value = t('agentProjectsPickerOpenFailed', 'Failed to open directory picker');
      return null;
    }
  }

  // Ensure default project exists (auto-create if no projects)
  async function ensureDefaultProject(): Promise<AgentProject | null> {
    const ready = await options.ensureServer();
    if (!ready) return null;

    try {
      // First fetch current projects
      await fetchProjects();

      // If there are already projects, no need to create default
      if (projects.value.length > 0) {
        return null;
      }

      // Get default workspace directory from server
      const defaultRootData = await requestAgentRpcJson<{ path?: string }>({
        operation: 'agent.projects.defaultRoot',
        body: { projectName: 'default' },
      });
      const defaultRoot = defaultRootData.path;

      if (!defaultRoot) {
        console.error('Failed to get default project root');
        return null;
      }

      // Create default project
      const payload = await requestAgentRpcJson<{ project?: AgentProject }>({
        operation: 'agent.projects.upsert',
        body: {
          name: 'Default',
          rootPath: defaultRoot,
          allowCreate: true,
        },
      });
      const project = payload?.project as AgentProject | undefined;

      if (project?.id) {
        projects.value = [project];
        selectedProjectId.value = project.id;
        await saveSelectedProjectId();
        return project;
      }

      return null;
    } catch (error) {
      console.error('Failed to ensure default project:', error);
      return null;
    }
  }

  // Create project from a directory path (used when user picks a directory)
  async function createProjectFromPath(
    rootPath: string,
    name: string,
  ): Promise<AgentProject | null> {
    const ready = await options.ensureServer();
    if (!ready) {
      projectError.value = t('agentProjectsServerUnavailable', 'Server not available');
      return null;
    }

    projectError.value = null;

    try {
      // Validate the path first
      const validation = await validatePath(rootPath);
      if (!validation) {
        projectError.value = t('agentProjectsValidateFailed', 'Failed to validate path');
        return null;
      }

      if (!validation.valid) {
        projectError.value = validation.error || t('agentProjectsInvalidPath', 'Invalid path');
        return null;
      }

      // Check if project with same path already exists
      const normalizedPath = normalizePathForComparison(validation.absolute);
      const existingProject = projects.value.find(
        (p) => normalizePathForComparison(p.rootPath) === normalizedPath,
      );

      if (existingProject) {
        // Project already exists - select it instead of creating a new one
        const shouldSwitch = confirm(
          t(
            'agentProjectsConfirmSwitchExisting',
            'A project already exists for "{0}": {1}\n\nSwitch to that project?',
            [validation.absolute, existingProject.name],
          ),
        );
        if (shouldSwitch) {
          selectedProjectId.value = existingProject.id;
          await saveSelectedProjectId();
          await loadChatHistory(existingProject.id);
          return existingProject;
        }
        // User declined to switch, return null to indicate no action taken
        return null;
      }

      // If directory doesn't exist, ask user for confirmation
      let allowCreate = false;
      if (validation.needsCreation) {
        const confirmed = confirm(
          t('agentProjectsConfirmCreateDir', 'The directory "{0}" does not exist. Create it?', [
            validation.absolute,
          ]),
        );
        if (!confirmed) {
          return null;
        }
        allowCreate = true;
      }

      // Create the project
      const payload = await requestAgentRpcJson<{ project?: AgentProject }>({
        operation: 'agent.projects.upsert',
        body: { name, rootPath, allowCreate },
      });
      const project = payload?.project as AgentProject | undefined;

      if (project?.id) {
        // Update local state
        const others = projects.value.filter((p) => p.id !== project.id);
        projects.value = [...others, project];
        selectedProjectId.value = project.id;
        await saveSelectedProjectId();
        await loadChatHistory(project.id);

        return project;
      } else {
        projectError.value = 'Project created but response is invalid.';
        return null;
      }
    } catch (error: unknown) {
      console.error('Failed to create project from path:', error);
      projectError.value = error instanceof Error ? error.message : 'Failed to create project.';
      return null;
    }
  }

  // Handle project change
  async function handleProjectChanged(): Promise<void> {
    await saveSelectedProjectId();
    if (selectedProjectId.value) {
      await loadChatHistory(selectedProjectId.value);
    }
  }

  // Save project preference (CLI, model, enableWebpageMcp)
  async function saveProjectPreference(
    cli?: string,
    model?: string,
    enableWebpageMcp?: boolean,
  ): Promise<void> {
    const project = selectedProject.value;
    if (!project) return;

    try {
      const payload = await requestAgentRpcJson<{ project?: AgentProject }>({
        operation: 'agent.projects.upsert',
        body: {
          id: project.id,
          name: project.name,
          rootPath: project.rootPath,
          // Normalize and allow empty string (means "Auto/Default")
          preferredCli: cli?.trim() ?? project.preferredCli,
          selectedModel: model?.trim() ?? project.selectedModel,
          enableWebpageMcp: enableWebpageMcp ?? project.enableWebpageMcp,
        },
      });

      const updatedProject = payload?.project as AgentProject | undefined;
      if (updatedProject?.id) {
        const index = projects.value.findIndex((p) => p.id === updatedProject.id);
        if (index !== -1) {
          projects.value[index] = updatedProject;
        }
      }
    } catch (error) {
      console.error('Failed to save project preference:', error);
    }
  }

  return {
    // State
    projects,
    selectedProjectId,
    isLoadingProjects,
    showCreateProject,
    newProjectName,
    newProjectRootPath,
    isCreatingProject,
    projectError,

    // Computed
    selectedProject,
    canCreateProject,

    // Methods
    loadSelectedProjectId,
    saveSelectedProjectId,
    fetchProjects,
    refreshProjects,
    loadChatHistory,
    createProject,
    toggleCreateProject,
    handleProjectChanged,
    saveProjectPreference,
    getDefaultProjectRoot,
    pickDirectory,
    ensureDefaultProject,
    createProjectFromPath,
  };
}
