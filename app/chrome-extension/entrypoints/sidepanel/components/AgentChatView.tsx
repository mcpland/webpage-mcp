import type {
  AgentEngineInfo,
  AgentManagementInfo,
  AgentProject,
  AgentSession,
  AgentUsageStats,
  CodexReasoningEffort,
  OpenProjectTarget,
} from 'webpage-mcp-shared';

import type { ModelDefinition } from '@/common/agent-models';
import type { AgentThemeId, WebEditorTxStateReturn } from '../composables';
import type { RequestState } from '../composables/useAgentChat';
import type { AgentThread } from '../composables/useAgentThreads';
import type { AttachmentWithPreview } from '../composables/useAttachments';
import AttachmentCachePanel from './agent-chat/AttachmentCachePanel';
import AgentChatShell from './agent-chat/AgentChatShell';
import AgentComposer from './agent-chat/AgentComposer';
import AgentConversation from './agent-chat/AgentConversation';
import AgentOpenProjectMenu from './agent-chat/AgentOpenProjectMenu';
import AgentProjectMenu from './agent-chat/AgentProjectMenu';
import AgentSessionMenu from './agent-chat/AgentSessionMenu';
import AgentSessionsView from './agent-chat/AgentSessionsView';
import AgentSessionSettingsPanel, {
  type SessionSettings,
} from './agent-chat/AgentSessionSettingsPanel';
import AgentSettingsMenu from './agent-chat/AgentSettingsMenu';
import AgentTopBar, { type ConnectionState } from './agent-chat/AgentTopBar';
import WebEditorChanges from './agent-chat/WebEditorChanges';

type SessionWithPreviewMeta = AgentSession & {
  previewMeta?: {
    displayText?: string;
    clientMeta?: {
      kind?: string;
      elementCount?: number;
    };
  };
};

type AgentChatViewProps = {
  theme: AgentThemeId;
  isSessionsView: boolean;
  allSessions: SessionWithPreviewMeta[];
  selectedSessionId: string;
  isLoadingAllSessions: boolean;
  isCreatingSession: boolean;
  sessionError: string | null;
  runningSessionIds: Set<string>;
  projectsMap: Map<string, AgentProject>;
  onSessionSelectAndNavigate: (sessionId: string) => void;
  onSessionNewAndNavigate: () => void;
  onDeleteSession: (sessionId: string) => void;
  onRenameSession: (sessionId: string, name: string) => void;
  onSessionOpenProject: (sessionId: string) => void;

  chatErrorMessage?: string | null;
  usage?: AgentUsageStats | null;
  footerLabel: string;
  onDismissError: () => void;

  projectLabel: string;
  sessionLabel: string;
  connectionState: ConnectionState;
  engineDisplayName: string;
  threads: AgentThread[];
  serverPort?: number | null;
  webEditorTxState: WebEditorTxStateReturn;

  inputValue: string;
  attachments: AttachmentWithPreview[];
  attachmentError?: string | null;
  isDragOver?: boolean;
  isStreaming: boolean;
  requestState: RequestState;
  sending: boolean;
  cancelling: boolean;
  canCancel: boolean;
  canSend: boolean;
  currentEngineName?: string;
  currentSessionModel: string;
  currentAvailableModels: ModelDefinition[];
  currentReasoningEffort: CodexReasoningEffort;
  currentAvailableReasoningEfforts: readonly CodexReasoningEffort[];
  fakeCaretEnabled?: boolean;
  onInputChange: (value: string) => void;
  onSend: () => void;
  onCancelRequest: () => void;
  onAttachmentAdd: () => void;
  onAttachmentRemove: (index: number) => void;
  onAttachmentDrop: (event: DragEvent) => void;
  onAttachmentPaste: (event: ClipboardEvent) => void;
  onAttachmentDragOver: (event: DragEvent) => void;
  onAttachmentDragLeave: (event: DragEvent) => void;
  onComposerModelChange: (modelId: string) => void;
  onComposerReasoningEffortChange: (effort: CodexReasoningEffort) => void;
  onComposerOpenSettings: () => void;
  onComposerReset: () => void;

  projectMenuOpen: boolean;
  sessionMenuOpen: boolean;
  settingsMenuOpen: boolean;
  openProjectMenuOpen: boolean;
  selectedProjectId: string;
  projects: AgentProject[];
  selectedCli: string;
  model: string;
  reasoningEffort: CodexReasoningEffort;
  enableWebpageMcp: boolean;
  engines: AgentEngineInfo[];
  isPickingDirectory: boolean;
  isSavingPreference: boolean;
  projectError: string | null;
  onToggleProjectMenu: () => void;
  onToggleSessionMenu: () => void;
  onToggleSettingsMenu: () => void;
  onToggleOpenProjectMenu: () => void;
  onBackToSessions: () => void;
  onCloseMenus: () => void;
  onProjectSelect: (projectId: string) => void;
  onNewProject: () => void;
  onCliUpdate: (cli: string) => void;
  onModelUpdate: (model: string) => void;
  onReasoningEffortUpdate: (effort: CodexReasoningEffort) => void;
  onWebpageMcpUpdate: (enableWebpageMcp: boolean) => void;
  onSaveSettings: () => void;

  projectSessions: AgentSession[];
  isLoadingSessions: boolean;
  onSessionSelect: (sessionId: string) => void;
  onNewSession: () => void;

  onThemeSet: (theme: AgentThemeId) => void;
  onReconnect: () => void;
  onAttachmentsOpen: () => void;
  onFakeCaretToggle: (enabled: boolean) => void;

  defaultOpenProjectTarget: OpenProjectTarget | null;
  onOpenProjectSelect: (target: OpenProjectTarget) => void;
  onCloseOpenProjectMenu: () => void;

  sessionSettingsOpen: boolean;
  selectedSession: AgentSession | null;
  currentManagementInfo: AgentManagementInfo | null;
  sessionSettingsLoading: boolean;
  sessionSettingsSaving: boolean;
  onCloseSessionSettings: () => void;
  onSaveSessionSettings: (settings: SessionSettings) => void;

  attachmentCacheOpen: boolean;
  onCloseAttachmentCache: () => void;
};

export default function AgentChatView(props: AgentChatViewProps) {
  return (
    <div className="agent-theme relative h-full" data-agent-theme={props.theme}>
      {props.isSessionsView ? (
        <AgentSessionsView
          sessions={props.allSessions}
          selectedSessionId={props.selectedSessionId}
          isLoading={props.isLoadingAllSessions}
          isCreating={props.isCreatingSession}
          error={props.sessionError}
          runningSessionIds={props.runningSessionIds}
          projectsMap={props.projectsMap}
          onSessionSelect={props.onSessionSelectAndNavigate}
          onSessionNew={props.onSessionNewAndNavigate}
          onSessionDelete={props.onDeleteSession}
          onSessionRename={props.onRenameSession}
          onSessionOpenProject={props.onSessionOpenProject}
        />
      ) : (
        <AgentChatShell
          errorMessage={props.chatErrorMessage}
          usage={props.usage}
          footerLabel={props.footerLabel}
          onErrorDismiss={props.onDismissError}
          header={
            <AgentTopBar
              projectLabel={props.projectLabel}
              sessionLabel={props.sessionLabel}
              connectionState={props.connectionState}
              showBackButton={true}
              brandLabel={props.engineDisplayName}
              onToggleProjectMenu={props.onToggleProjectMenu}
              onToggleSessionMenu={props.onToggleSessionMenu}
              onToggleSettingsMenu={props.onToggleSettingsMenu}
              onToggleOpenProjectMenu={props.onToggleOpenProjectMenu}
              onBack={props.onBackToSessions}
            />
          }
          content={<AgentConversation threads={props.threads} serverPort={props.serverPort} />}
          composer={
            <>
              <WebEditorChanges txState={props.webEditorTxState} />
              <AgentComposer
                modelValue={props.inputValue}
                attachments={props.attachments}
                attachmentError={props.attachmentError}
                isDragOver={props.isDragOver}
                isStreaming={props.isStreaming}
                requestState={props.requestState}
                sending={props.sending}
                cancelling={props.cancelling}
                canCancel={props.canCancel}
                canSend={props.canSend}
                placeholder="Ask Claude to write code..."
                engineName={props.currentEngineName}
                selectedModel={props.currentSessionModel}
                availableModels={props.currentAvailableModels}
                reasoningEffort={props.currentReasoningEffort}
                availableReasoningEfforts={props.currentAvailableReasoningEfforts}
                enableFakeCaret={props.fakeCaretEnabled}
                onUpdateModelValue={props.onInputChange}
                onSubmit={props.onSend}
                onCancel={props.onCancelRequest}
                onAttachmentAdd={props.onAttachmentAdd}
                onAttachmentRemove={props.onAttachmentRemove}
                onAttachmentDrop={props.onAttachmentDrop}
                onAttachmentPaste={props.onAttachmentPaste}
                onAttachmentDragOver={props.onAttachmentDragOver}
                onAttachmentDragLeave={props.onAttachmentDragLeave}
                onModelChange={props.onComposerModelChange}
                onReasoningEffortChange={props.onComposerReasoningEffortChange}
                onSessionSettings={props.onComposerOpenSettings}
                onSessionReset={props.onComposerReset}
              />
            </>
          }
        />
      )}

      {props.projectMenuOpen ||
      props.sessionMenuOpen ||
      props.settingsMenuOpen ||
      props.openProjectMenuOpen ? (
        <div className="fixed inset-0 z-40" onClick={props.onCloseMenus} />
      ) : null}

      <AgentProjectMenu
        open={props.projectMenuOpen}
        projects={props.projects}
        selectedProjectId={props.selectedProjectId}
        selectedCli={props.selectedCli}
        model={props.model}
        reasoningEffort={props.reasoningEffort}
        enableWebpageMcp={props.enableWebpageMcp}
        engines={props.engines}
        isPicking={props.isPickingDirectory}
        isSaving={props.isSavingPreference}
        error={props.projectError}
        onProjectSelect={props.onProjectSelect}
        onProjectNew={props.onNewProject}
        onCliUpdate={props.onCliUpdate}
        onModelUpdate={props.onModelUpdate}
        onReasoningEffortUpdate={props.onReasoningEffortUpdate}
        onWebpageMcpUpdate={props.onWebpageMcpUpdate}
        onSave={props.onSaveSettings}
      />

      <AgentSessionMenu
        open={props.sessionMenuOpen}
        sessions={props.projectSessions}
        selectedSessionId={props.selectedSessionId}
        isLoading={props.isLoadingSessions}
        isCreating={props.isCreatingSession}
        error={props.sessionError}
        onSessionSelect={props.onSessionSelect}
        onSessionNew={props.onNewSession}
        onSessionDelete={props.onDeleteSession}
        onSessionRename={props.onRenameSession}
      />

      <AgentSettingsMenu
        open={props.settingsMenuOpen}
        theme={props.theme}
        fakeCaretEnabled={props.fakeCaretEnabled}
        onThemeSet={props.onThemeSet}
        onReconnect={props.onReconnect}
        onAttachmentsOpen={props.onAttachmentsOpen}
        onFakeCaretToggle={props.onFakeCaretToggle}
      />

      <AgentOpenProjectMenu
        open={props.openProjectMenuOpen}
        defaultTarget={props.defaultOpenProjectTarget}
        onSelect={props.onOpenProjectSelect}
        onClose={props.onCloseOpenProjectMenu}
      />

      <AgentSessionSettingsPanel
        open={props.sessionSettingsOpen}
        session={props.selectedSession}
        managementInfo={props.currentManagementInfo}
        isLoading={props.sessionSettingsLoading}
        isSaving={props.sessionSettingsSaving}
        onClose={props.onCloseSessionSettings}
        onSave={props.onSaveSessionSettings}
      />

      <AttachmentCachePanel
        open={props.attachmentCacheOpen}
        serverPort={props.serverPort}
        onClose={props.onCloseAttachmentCache}
      />
    </div>
  );
}
