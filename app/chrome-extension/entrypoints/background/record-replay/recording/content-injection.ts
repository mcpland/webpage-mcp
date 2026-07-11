import { TOOL_MESSAGE_TYPES } from "@/common/message-types";

// Avoid magic strings for recorder control commands
export type RecorderCmd = "start" | "stop" | "pause" | "resume" | "recover";
export const REC_CMD = {
  START: "start",
  STOP: "stop",
  PAUSE: "pause",
  RESUME: "resume",
  RECOVER: "recover",
} as const satisfies Record<string, RecorderCmd>;

const RECORDER_SCRIPT_FILES = [
  "inject-scripts/recorder-shared.js",
  "inject-scripts/recorder.js",
] as const;

export async function ensureRecorderInjected(tabId: number): Promise<void> {
  // Discover frames (top + subframes)
  let frames: Array<{ frameId: number } & Record<string, any>> = [];
  try {
    const res = (await chrome.webNavigation.getAllFrames({ tabId })) as
      | Array<{ frameId: number } & Record<string, any>>
      | null
      | undefined;
    frames = Array.isArray(res) ? res : [];
  } catch {
    // ignore and fallback to top frame only
  }
  if (frames.length === 0) frames = [{ frameId: 0 }];

  const needRecorder: number[] = [];
  await Promise.all(
    frames.map(async (f) => {
      const frameId = f.frameId ?? 0;
      try {
        const res = await chrome.tabs.sendMessage(
          tabId,
          { action: "rr_recorder_ping" },
          { frameId },
        );
        const pong = res?.status === "pong";
        if (!pong) needRecorder.push(frameId);
      } catch {
        needRecorder.push(frameId);
      }
    }),
  );

  if (needRecorder.length > 0) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId, frameIds: needRecorder },
        files: [...RECORDER_SCRIPT_FILES],
        world: "ISOLATED",
      });
    } catch {
      // Fallback: try allFrames to cover dynamic/subframe changes; safe due to idempotent guard in recorder.js
      try {
        await chrome.scripting.executeScript({
          target: { tabId, allFrames: true },
          files: [...RECORDER_SCRIPT_FILES],
          world: "ISOLATED",
        });
      } catch {
        // ignore injection failures per-tab
      }
    }
  }
}

export async function broadcastControlToTab(
  tabId: number,
  cmd: RecorderCmd,
  meta?: unknown,
): Promise<boolean> {
  try {
    const res = (await chrome.webNavigation.getAllFrames({ tabId })) as
      | Array<{ frameId: number } & Record<string, any>>
      | null
      | undefined;
    const targets = Array.isArray(res) && res.length ? res : [{ frameId: 0 }];
    let topFrameAccepted = false;
    await Promise.all(
      targets.map(async (f) => {
        try {
          const response = await chrome.tabs.sendMessage(
            tabId,
            { action: TOOL_MESSAGE_TYPES.RR_RECORDER_CONTROL, cmd, meta },
            { frameId: f.frameId },
          );
          if (f.frameId === 0) topFrameAccepted = response?.success === true;
        } catch {
          // ignore per-frame send failure
        }
      }),
    );
    return topFrameAccepted;
  } catch {
    return false;
  }
}

/**
 * Rebind the top-frame recorder to a restarted MV3 worker without resetting its
 * in-page batch, sequence counter, or pending frame correlations.
 */
export async function recoverRecorderControlInTab(
  tabId: number,
  sessionId: string,
  desiredStatus: "recording" | "paused",
  documentId?: string,
): Promise<boolean> {
  try {
    const options: chrome.tabs.MessageSendOptions = documentId
      ? { documentId }
      : { frameId: 0 };
    const response = await chrome.tabs.sendMessage(
      tabId,
      {
        action: TOOL_MESSAGE_TYPES.RR_RECORDER_CONTROL,
        cmd: REC_CMD.RECOVER,
        meta: { sessionId, desiredStatus },
      },
      options,
    );
    return response?.success === true && response?.active === true;
  } catch {
    return false;
  }
}
