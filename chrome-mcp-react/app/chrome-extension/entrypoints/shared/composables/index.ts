/**
 * @fileoverview Shared UI Composables
 * @description Composables shared between multiple UI entrypoints (Sidepanel, Builder, Popup, etc.)
 *
 * Note: These composables are for UI-only use. Do not import them in background scripts
 * as they depend on Vue and will bloat the service worker bundle.
 */

// RR V3 RPC Client
export { useRRV3Rpc } from './useRRV3Rpc';
export type { UseRRV3Rpc, UseRRV3RpcOptions, RpcRequestOptions } from './useRRV3Rpc';
