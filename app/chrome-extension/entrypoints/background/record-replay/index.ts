import { BACKGROUND_MESSAGE_TYPES } from '@/common/message-types';
import type { FlowId } from '../record-replay-v3/domain/ids';
import type { FlowToolMetadata, FlowV3 } from '../record-replay-v3/domain/flow';
import type { JsonObject } from '../record-replay-v3/domain/json';
import {
  ensurePublishedSlugAvailable,
  mergeFlowToolMetadata,
  normalizeToolSlug,
} from '../record-replay-v3/flows/publish';
import { normalizeFlowToolMetadata } from '../record-replay-v3/flows/normalize-flow-optional-fields';
import {
  enqueueRunAndWait,
  ensureV3Runtime,
  exportAllFlowsJson,
  exportFlowJson,
  importFlowsToV3,
  saveFlowToV3,
} from '../record-replay-v3/compat';
import { RecorderManager } from './recording/recorder-manager';
import { buildRecordingStateSnapshot } from './recording/recording-state';

const DISABLED_AUTOMATION_SURFACE_ERROR =
  'Triggers and schedules are not supported in the single-path RR-V3 runtime.';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

async function broadcastFlowsChanged(): Promise<void> {
  await chrome.runtime
    .sendMessage({ type: BACKGROUND_MESSAGE_TYPES.RR_FLOWS_CHANGED })
    .catch(() => {});
}

async function updatePublishedState(
  flowId: string,
  patch: Partial<FlowToolMetadata>,
): Promise<void> {
  const runtime = await ensureV3Runtime();
  const flow = await runtime.storage.flows.get(flowId as FlowId);
  if (!flow) {
    throw new Error(`Flow "${flowId}" not found`);
  }

  const toolPatchInput: JsonObject = {};
  if (patch.published !== undefined) {
    toolPatchInput.published = patch.published;
  }
  if (patch.slug !== undefined) {
    toolPatchInput.slug = patch.slug;
  }
  if (patch.category !== undefined) {
    toolPatchInput.category = patch.category;
  }
  if (patch.description !== undefined) {
    toolPatchInput.description = patch.description;
  }
  const normalizedToolPatch = normalizeFlowToolMetadata(toolPatchInput, flow.name) ?? {};

  const nextFlow: FlowV3 = {
    ...flow,
    updatedAt: new Date().toISOString(),
    meta: mergeFlowToolMetadata(flow.meta, normalizedToolPatch),
  };

  if (nextFlow.meta?.tool?.published) {
    const allFlows = await runtime.storage.flows.list();
    ensurePublishedSlugAvailable(
      allFlows,
      nextFlow.id,
      normalizeToolSlug(nextFlow.meta.tool.slug, nextFlow.name),
    );
  }

  await runtime.storage.flows.save(nextFlow);
}

export function initRecordReplayListeners(): void {
  RecorderManager.init().catch(() => {});

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    try {
      switch (message?.type) {
        case BACKGROUND_MESSAGE_TYPES.RR_START_RECORDING: {
          RecorderManager.start(message.meta, message.tabId)
            .then((result) =>
              sendResponse({
                ...result,
                state: buildRecordingStateSnapshot(),
              }),
            )
            .catch((error) => sendResponse({ success: false, error: errorMessage(error) }));
          return true;
        }

        case BACKGROUND_MESSAGE_TYPES.RR_STOP_RECORDING: {
          RecorderManager.stop()
            .then((result) =>
              sendResponse({
                ...result,
                state: buildRecordingStateSnapshot(),
              }),
            )
            .catch((error) => sendResponse({ success: false, error: errorMessage(error) }));
          return true;
        }

        case BACKGROUND_MESSAGE_TYPES.RR_PAUSE_RECORDING: {
          RecorderManager.pause()
            .then((result) =>
              sendResponse({
                ...result,
                state: buildRecordingStateSnapshot(),
              }),
            )
            .catch((error) => sendResponse({ success: false, error: errorMessage(error) }));
          return true;
        }

        case BACKGROUND_MESSAGE_TYPES.RR_RESUME_RECORDING: {
          RecorderManager.resume()
            .then((result) =>
              sendResponse({
                ...result,
                state: buildRecordingStateSnapshot(),
              }),
            )
            .catch((error) => sendResponse({ success: false, error: errorMessage(error) }));
          return true;
        }

        case BACKGROUND_MESSAGE_TYPES.RR_GET_RECORDING_STATUS: {
          const state = buildRecordingStateSnapshot();
          sendResponse({
            success: true,
            state,
            status: state.status,
            sessionId: state.sessionId,
            originTabId: state.originTabId,
          });
          return true;
        }

        case BACKGROUND_MESSAGE_TYPES.RR_LIST_FLOWS: {
          ensureV3Runtime()
            .then((runtime) => runtime.storage.flows.list())
            .then((flows) => sendResponse({ success: true, flows }))
            .catch((error) => sendResponse({ success: false, error: errorMessage(error) }));
          return true;
        }

        case BACKGROUND_MESSAGE_TYPES.RR_GET_FLOW: {
          ensureV3Runtime()
            .then((runtime) => runtime.storage.flows.get(String(message.flowId || '') as FlowId))
            .then((flow) => sendResponse({ success: !!flow, flow }))
            .catch((error) => sendResponse({ success: false, error: errorMessage(error) }));
          return true;
        }

        case BACKGROUND_MESSAGE_TYPES.RR_DELETE_FLOW: {
          ensureV3Runtime()
            .then(async (runtime) => {
              await runtime.storage.flows.delete(String(message.flowId || '') as FlowId);
              await broadcastFlowsChanged();
              sendResponse({ success: true });
            })
            .catch((error) => sendResponse({ success: false, error: errorMessage(error) }));
          return true;
        }

        case BACKGROUND_MESSAGE_TYPES.RR_PUBLISH_FLOW: {
          updatePublishedState(String(message.flowId || ''), {
            published: true,
            slug: normalizeString(message.slug) || undefined,
          })
            .then(async () => {
              await broadcastFlowsChanged();
              sendResponse({ success: true });
            })
            .catch((error) => sendResponse({ success: false, error: errorMessage(error) }));
          return true;
        }

        case BACKGROUND_MESSAGE_TYPES.RR_UNPUBLISH_FLOW: {
          updatePublishedState(String(message.flowId || ''), {
            published: false,
          })
            .then(async () => {
              await broadcastFlowsChanged();
              sendResponse({ success: true });
            })
            .catch((error) => sendResponse({ success: false, error: errorMessage(error) }));
          return true;
        }

        case BACKGROUND_MESSAGE_TYPES.RR_RUN_FLOW: {
          const options =
            message.options && typeof message.options === 'object'
              ? (message.options as Record<string, unknown>)
              : {};

          enqueueRunAndWait({
            flowId: String(message.flowId || '') as FlowId,
            tabId: typeof options.tabId === 'number' ? Math.floor(options.tabId) : undefined,
            tabTarget: options.tabTarget === 'new' ? 'new' : 'current',
            args:
              options.args && typeof options.args === 'object' && !Array.isArray(options.args)
                ? (options.args as JsonObject)
                : undefined,
            startUrl: normalizeString(options.startUrl) || undefined,
            refresh: options.refresh === true,
            startNodeId: normalizeString(options.startNodeId),
            timeoutMs:
              typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs)
                ? Math.floor(options.timeoutMs)
                : undefined,
          })
            .then(({ result }) => sendResponse({ success: true, result }))
            .catch((error) => sendResponse({ success: false, error: errorMessage(error) }));
          return true;
        }

        case BACKGROUND_MESSAGE_TYPES.RR_SAVE_FLOW: {
          saveFlowToV3(message.flow)
            .then(async (flow) => {
              await broadcastFlowsChanged();
              sendResponse({ success: true, flow });
            })
            .catch((error) => sendResponse({ success: false, error: errorMessage(error) }));
          return true;
        }

        case BACKGROUND_MESSAGE_TYPES.RR_EXPORT_FLOW: {
          exportFlowJson(String(message.flowId || ''))
            .then((json) => sendResponse({ success: true, json }))
            .catch((error) => sendResponse({ success: false, error: errorMessage(error) }));
          return true;
        }

        case BACKGROUND_MESSAGE_TYPES.RR_EXPORT_ALL: {
          exportAllFlowsJson()
            .then((json) => sendResponse({ success: true, json }))
            .catch((error) => sendResponse({ success: false, error: errorMessage(error) }));
          return true;
        }

        case BACKGROUND_MESSAGE_TYPES.RR_IMPORT_FLOW: {
          importFlowsToV3(String(message.json || ''))
            .then(async (flows) => {
              await broadcastFlowsChanged();
              sendResponse({ success: true, imported: flows.length, flows });
            })
            .catch((error) => sendResponse({ success: false, error: errorMessage(error) }));
          return true;
        }

        case BACKGROUND_MESSAGE_TYPES.RR_LIST_RUNS: {
          ensureV3Runtime()
            .then((runtime) => runtime.storage.runs.list())
            .then((runs) => sendResponse({ success: true, runs }))
            .catch((error) => sendResponse({ success: false, error: errorMessage(error) }));
          return true;
        }

        case BACKGROUND_MESSAGE_TYPES.RR_LIST_TRIGGERS: {
          sendResponse({ success: true, triggers: [] });
          return true;
        }

        case BACKGROUND_MESSAGE_TYPES.RR_SAVE_TRIGGER:
        case BACKGROUND_MESSAGE_TYPES.RR_DELETE_TRIGGER:
        case BACKGROUND_MESSAGE_TYPES.RR_REFRESH_TRIGGERS:
        case BACKGROUND_MESSAGE_TYPES.RR_LIST_SCHEDULES:
        case BACKGROUND_MESSAGE_TYPES.RR_SCHEDULE_FLOW:
        case BACKGROUND_MESSAGE_TYPES.RR_UNSCHEDULE_FLOW: {
          sendResponse({ success: false, error: DISABLED_AUTOMATION_SURFACE_ERROR });
          return true;
        }

        default:
          return false;
      }
    } catch (error) {
      sendResponse({ success: false, error: errorMessage(error) });
      return false;
    }
  });
}
