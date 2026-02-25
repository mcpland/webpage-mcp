<template>
  <div class="px-4 py-4 space-y-3">
    <!-- Connection Status -->
    <div
      class="bg-white rounded-lg border border-slate-200 p-3 flex items-center justify-between gap-3"
    >
      <div class="flex items-center gap-2 text-sm text-slate-700 min-w-0">
        <span :class="['inline-flex h-2 w-2 rounded-full shrink-0', connectionDotClass]" />
        <span class="font-semibold shrink-0">RR V3 Debugger</span>
        <span class="text-slate-400 shrink-0">·</span>
        <span class="text-slate-600 truncate">{{ connectionText }}</span>
      </div>

      <button
        class="shrink-0 inline-flex items-center justify-center rounded-lg px-3 py-1.5 text-xs font-medium transition border bg-white text-slate-700 border-slate-200 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed"
        :disabled="rpc.connecting.value || rpc.reconnecting.value"
        @click="handleReconnect"
      >
        {{ rpc.connecting.value || rpc.reconnecting.value ? 'Reconnecting…' : 'Reconnect' }}
      </button>
    </div>

    <!-- Debugger State -->
    <div class="bg-white rounded-lg border border-slate-200 p-4 space-y-3">
      <div class="flex items-center justify-between gap-3">
        <div class="text-slate-800 font-semibold">State</div>
        <div class="text-xs text-slate-400">
          <span v-if="debuggerClient.busy.value">Working…</span>
          <span v-else-if="rpc.pendingCount.value > 0">Pending: {{ rpc.pendingCount.value }}</span>
        </div>
      </div>

      <div class="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
        <div class="text-slate-500">runId</div>
        <div class="font-mono text-xs text-slate-800 break-all">
          {{ runIdDisplay }}
        </div>

        <div class="text-slate-500">status</div>
        <div class="text-slate-800">
          <span
            :class="[
              'inline-flex items-center px-2 py-0.5 rounded text-xs',
              debuggerState?.status === 'attached'
                ? 'bg-emerald-50 text-emerald-700'
                : 'bg-slate-100 text-slate-600',
            ]"
          >
            {{ debuggerState?.status ?? '—' }}
          </span>
        </div>

        <div class="text-slate-500">execution</div>
        <div class="text-slate-800">
          <span
            :class="[
              'inline-flex items-center px-2 py-0.5 rounded text-xs',
              debuggerState?.execution === 'paused'
                ? 'bg-amber-50 text-amber-700'
                : debuggerState?.execution === 'running'
                  ? 'bg-blue-50 text-blue-700'
                  : 'bg-slate-100 text-slate-600',
            ]"
          >
            {{ debuggerState?.execution ?? '—' }}
          </span>
        </div>

        <div class="text-slate-500">currentNodeId</div>
        <div class="font-mono text-xs text-slate-800 break-all">
          {{ debuggerState?.currentNodeId ?? '—' }}
        </div>

        <div class="text-slate-500">pauseReason</div>
        <div class="text-xs text-slate-800">
          {{ pauseReasonDisplay }}
        </div>
      </div>

      <!-- Control Buttons -->
      <div class="pt-3 border-t border-slate-100 flex flex-wrap gap-2">
        <button
          :class="[
            'inline-flex items-center justify-center rounded-lg px-3 py-2 text-sm font-medium transition border',
            canAttach
              ? 'bg-emerald-500 text-white border-emerald-500 hover:bg-emerald-600'
              : 'bg-white text-slate-400 border-slate-200 cursor-not-allowed',
          ]"
          :disabled="!canAttach"
          @click="handleAttach"
        >
          Attach
        </button>
        <button
          :class="[
            'inline-flex items-center justify-center rounded-lg px-3 py-2 text-sm font-medium transition border',
            canDetach
              ? 'bg-white text-slate-800 border-slate-200 hover:bg-slate-50'
              : 'bg-white text-slate-400 border-slate-200 cursor-not-allowed',
          ]"
          :disabled="!canDetach"
          @click="handleDetach"
        >
          Detach
        </button>
        <button
          :class="[
            'inline-flex items-center justify-center rounded-lg px-3 py-2 text-sm font-medium transition border',
            canPause
              ? 'bg-amber-500 text-white border-amber-500 hover:bg-amber-600'
              : 'bg-white text-slate-400 border-slate-200 cursor-not-allowed',
          ]"
          :disabled="!canPause"
          @click="handlePause"
        >
          Pause
        </button>
        <button
          :class="[
            'inline-flex items-center justify-center rounded-lg px-3 py-2 text-sm font-medium transition border',
            canResume
              ? 'bg-blue-500 text-white border-blue-500 hover:bg-blue-600'
              : 'bg-white text-slate-400 border-slate-200 cursor-not-allowed',
          ]"
          :disabled="!canResume"
          @click="handleResume"
        >
          Resume
        </button>
        <button
          :class="[
            'inline-flex items-center justify-center rounded-lg px-3 py-2 text-sm font-medium transition border',
            canStepOver
              ? 'bg-white text-slate-800 border-slate-200 hover:bg-slate-50'
              : 'bg-white text-slate-400 border-slate-200 cursor-not-allowed',
          ]"
          :disabled="!canStepOver"
          @click="handleStepOver"
        >
          Step Over
        </button>
      </div>

      <!-- Error Display -->
      <div v-if="errorText" class="text-sm text-red-600 bg-red-50 rounded px-3 py-2">
        {{ errorText }}
      </div>
    </div>

    <!-- Breakpoints -->
    <div class="bg-white rounded-lg border border-slate-200 p-4">
      <div class="flex items-center justify-between gap-3 mb-2">
        <div class="text-slate-800 font-semibold">Breakpoints</div>
        <div class="text-xs text-slate-400">{{ breakpoints.length }} total</div>
      </div>

      <div v-if="breakpoints.length === 0" class="text-sm text-slate-500">No breakpoints set.</div>

      <ul v-else class="divide-y divide-slate-100">
        <li
          v-for="bp in breakpoints"
          :key="bp.nodeId"
          class="py-2 flex items-start justify-between"
        >
          <div class="min-w-0">
            <div class="font-mono text-xs text-slate-800 break-all">{{ bp.nodeId }}</div>
          </div>
          <span
            class="ml-3 inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] whitespace-nowrap"
            :class="
              bp.enabled
                ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                : 'bg-slate-50 text-slate-600 border-slate-200'
            "
          >
            {{ bp.enabled ? 'enabled' : 'disabled' }}
          </span>
        </li>
      </ul>
    </div>
  </div>
</template>

<script lang="ts" setup>
import { computed, onUnmounted, watch } from 'vue';

import type { DebuggerState } from '@/entrypoints/background/record-replay-v3/domain/debug';
import type { PauseReason } from '@/entrypoints/background/record-replay-v3/domain/events';
import type { RunId } from '@/entrypoints/background/record-replay-v3/domain/ids';

import { useRRV3Debugger, useRRV3Rpc } from '../../composables';

// ==================== Props ====================

const props = defineProps<{
  runId: RunId;
}>();

// ==================== Composables ====================

const normalizedRunId = computed<RunId>(() => String(props.runId ?? '').trim() as RunId);
const hasRunId = computed(() => normalizedRunId.value.length > 0);

const rpc = useRRV3Rpc({ autoConnect: true });
const debuggerClient = useRRV3Debugger({
  rpc,
  getRunId: () => (hasRunId.value ? normalizedRunId.value : null),
  autoRefreshOnEvents: true,
});

// ==================== Computed ====================

const debuggerState = computed<DebuggerState | null>(() => debuggerClient.state.value);
const breakpoints = computed(() => debuggerState.value?.breakpoints ?? []);
const runIdDisplay = computed(() => (hasRunId.value ? normalizedRunId.value : '—'));
const errorText = computed(() => debuggerClient.lastError.value || rpc.lastError.value);

/**
 * Format PauseReason for display
 */
function formatPauseReason(reason: PauseReason | undefined): string {
  if (!reason) return '—';
  switch (reason.kind) {
    case 'breakpoint':
      return `Breakpoint at ${reason.nodeId}`;
    case 'step':
      return `Step at ${reason.nodeId}`;
    case 'command':
      return 'Manual pause';
    case 'policy':
      return `Policy: ${reason.reason} at ${reason.nodeId}`;
    default:
      return '—';
  }
}

const pauseReasonDisplay = computed(() => formatPauseReason(debuggerState.value?.pauseReason));

const connectionText = computed(() => {
  if (rpc.connected.value) return 'Connected';
  if (rpc.connecting.value) return 'Connecting…';
  if (rpc.reconnecting.value) return `Reconnecting (attempt ${rpc.reconnectAttempts.value})…`;
  return 'Disconnected';
});

const connectionDotClass = computed(() => {
  if (rpc.connected.value) return 'bg-emerald-500';
  if (rpc.connecting.value || rpc.reconnecting.value) return 'bg-amber-500';
  return 'bg-slate-400';
});

// Button state - require connection for all actions
const isConnected = computed(() => rpc.connected.value);
const canAttach = computed(
  () =>
    isConnected.value &&
    hasRunId.value &&
    !debuggerClient.busy.value &&
    !debuggerClient.isAttached.value,
);
const canDetach = computed(
  () =>
    isConnected.value &&
    hasRunId.value &&
    !debuggerClient.busy.value &&
    debuggerClient.isAttached.value,
);
const canPause = computed(
  () =>
    isConnected.value &&
    hasRunId.value &&
    !debuggerClient.busy.value &&
    debuggerClient.isAttached.value &&
    !debuggerClient.isPaused.value,
);
const canResume = computed(
  () =>
    isConnected.value &&
    hasRunId.value &&
    !debuggerClient.busy.value &&
    debuggerClient.isAttached.value &&
    debuggerClient.isPaused.value,
);
const canStepOver = computed(
  () =>
    isConnected.value &&
    hasRunId.value &&
    !debuggerClient.busy.value &&
    debuggerClient.isAttached.value &&
    debuggerClient.isPaused.value,
);

// ==================== Handlers ====================

async function handleReconnect(): Promise<void> {
  rpc.disconnect('Manual reconnect');
  const connected = await rpc.connect();
  if (!connected) return; // Connection failed, error already displayed

  if (hasRunId.value) {
    await rpc.subscribe(normalizedRunId.value);
    await debuggerClient.attach();
  }
}

async function handleAttach(): Promise<void> {
  const response = await debuggerClient.attach();
  if (response.ok && hasRunId.value) {
    // Subscribe to events for this run
    await rpc.subscribe(normalizedRunId.value);
  }
}

async function handleDetach(): Promise<void> {
  if (hasRunId.value) {
    // Unsubscribe from events
    await rpc.unsubscribe(normalizedRunId.value);
  }
  await debuggerClient.detach();
}

async function handlePause(): Promise<void> {
  await debuggerClient.pause();
}

async function handleResume(): Promise<void> {
  await debuggerClient.resume();
}

async function handleStepOver(): Promise<void> {
  await debuggerClient.stepOver();
}

// ==================== Auto-attach ====================

// Track current subscribed runId for cleanup
let currentSubscribedRunId: RunId | null = null;
let attachToken = 0;

watch(
  normalizedRunId,
  async (next, prev) => {
    const nextId = String(next ?? '').trim();
    if (!nextId) return;

    const token = ++attachToken;

    // Cleanup previous subscription and detach
    const prevId = String(prev ?? '').trim();
    if (prevId && prevId !== nextId) {
      if (currentSubscribedRunId === prevId) {
        await rpc.unsubscribe(prevId as RunId);
        currentSubscribedRunId = null;
      }
      await debuggerClient.detach(prevId as RunId);
      if (token !== attachToken) return; // Cancelled
    }

    // Attach and subscribe to new run
    const response = await debuggerClient.attach(nextId as RunId);
    if (token !== attachToken) return; // Cancelled

    if (response.ok) {
      await rpc.subscribe(nextId as RunId);
      currentSubscribedRunId = nextId as RunId;
    }
  },
  { immediate: true },
);

// Cleanup on unmount
onUnmounted(async () => {
  if (currentSubscribedRunId) {
    await rpc.unsubscribe(currentSubscribedRunId);
  }
});
</script>
