/**
 * Selector Locator - Element locator
 * Locate DOM elements using selector candidate list
 */

import { TOOL_MESSAGE_TYPES } from '../../common/message-types';
import {
  composeCompositeSelector,
  isCompositeSelector,
  splitCompositeSelector,
  type LocatedElement,
  type Point,
  type SelectorCandidate,
  type SelectorLocateOptions,
  type SelectorTarget,
} from './types';
import { compareSelectorCandidates, withStability } from './stability';

// ================================
// Message type definitions
// ================================

interface EnsureRefForSelectorRequest {
  action: typeof TOOL_MESSAGE_TYPES.ENSURE_REF_FOR_SELECTOR;
  selector?: string;
  useText?: boolean;
  text?: string;
  isXPath?: boolean;
  tagName?: string;
  allowMultiple?: boolean;
}

type EnsureRefForSelectorResponse =
  | { success: true; ref: string; center: Point; href?: string }
  | { success: false; error?: string; cancelled?: boolean };

interface ResolveRefRequest {
  action: typeof TOOL_MESSAGE_TYPES.RESOLVE_REF;
  ref: string;
}

type ResolveRefResponse =
  | {
      success: true;
      center: Point;
      rect?: { x: number; y: number; width: number; height: number };
      selector?: string;
    }
  | { success: false; error?: string };

interface VerifyFingerprintRequest {
  action: typeof TOOL_MESSAGE_TYPES.VERIFY_FINGERPRINT;
  ref: string;
  fingerprint: string;
}

type VerifyFingerprintResponse =
  | { success: true; match: boolean }
  | { success: false; error?: string };

// ================================
// Transport layer interface
// ================================

export interface SelectorLocatorTransport {
  sendMessage: (
    tabId: number,
    message: unknown,
    options?: { frameId?: number },
  ) => Promise<unknown>;
  getAllFrames?: (tabId: number) => Promise<ReadonlyArray<{ frameId: number; url: string }>>;
}

// ================================
// Utility functions
// ================================

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isPoint(value: unknown): value is Point {
  if (!isRecord(value)) return false;
  return (
    typeof value.x === 'number' &&
    Number.isFinite(value.x) &&
    typeof value.y === 'number' &&
    Number.isFinite(value.y)
  );
}

function parseEnsureRefResponse(value: unknown): EnsureRefForSelectorResponse | null {
  if (!isRecord(value) || typeof value.success !== 'boolean') return null;

  if (value.success) {
    if (typeof value.ref !== 'string' || !isPoint(value.center)) return null;
    const href = typeof value.href === 'string' ? value.href : undefined;
    return { success: true, ref: value.ref, center: value.center, href };
  }

  const error = typeof value.error === 'string' ? value.error : undefined;
  const cancelled = typeof value.cancelled === 'boolean' ? value.cancelled : undefined;
  return { success: false, error, cancelled };
}

function parseResolveRefResponse(value: unknown): ResolveRefResponse | null {
  if (!isRecord(value) || typeof value.success !== 'boolean') return null;

  if (value.success) {
    if (!isPoint(value.center)) return null;

    const rect =
      isRecord(value.rect) &&
      typeof value.rect.x === 'number' &&
      typeof value.rect.y === 'number' &&
      typeof value.rect.width === 'number' &&
      typeof value.rect.height === 'number'
        ? {
            x: value.rect.x,
            y: value.rect.y,
            width: value.rect.width,
            height: value.rect.height,
          }
        : undefined;

    const selector = typeof value.selector === 'string' ? value.selector : undefined;
    return { success: true, center: value.center, rect, selector };
  }

  const error = typeof value.error === 'string' ? value.error : undefined;
  return { success: false, error };
}

function parseVerifyFingerprintResponse(value: unknown): VerifyFingerprintResponse | null {
  if (!isRecord(value) || typeof value.success !== 'boolean') return null;

  if (value.success) {
    if (typeof value.match !== 'boolean') return null;
    return { success: true, match: value.match };
  }

  const error = typeof value.error === 'string' ? value.error : undefined;
  return { success: false, error };
}

function deriveFrameSelector(target: SelectorTarget): string | undefined {
  if (typeof target.selector === 'string') {
    const parts = splitCompositeSelector(target.selector);
    if (parts) return parts.frameSelector;
  }
  for (const c of target.candidates) {
    const parts = splitCompositeSelector(c.value);
    if (parts) return parts.frameSelector;
  }
  return undefined;
}

function deriveTagNameHint(
  target: SelectorTarget,
  candidate: SelectorCandidate | undefined,
): string | undefined {
  if (candidate?.type === 'text' && candidate.tagNameHint) return candidate.tagNameHint;
  return target.tagName;
}

function parseAriaExpr(expr: string): { role?: string; name?: string } {
  const v = String(expr || '').trim();
  const m = v.match(/^(\w+)\s*\[\s*name\s*=\s*([^\]]+)\s*\]$/);
  if (!m) return {};
  const role = m[1]?.trim();
  const rawName = m[2]?.trim();
  const name = rawName ? rawName.replace(/^['"]|['"]$/g, '') : undefined;
  return { role: role || undefined, name: name || undefined };
}

function uniqStrings(items: ReadonlyArray<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of items) {
    const v = s.trim();
    if (!v) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function ariaToCssSelectors(role: string | undefined, name: string | undefined): string[] {
  if (!name || !name.trim()) return [];
  const cleanRole = role?.trim();
  const cleanName = name.trim();
  const qName = JSON.stringify(cleanName);

  const out: string[] = [];

  if (cleanRole) out.push(`[role=${JSON.stringify(cleanRole)}][aria-label=${qName}]`);

  if (cleanRole === 'textbox') {
    out.unshift(
      `input[aria-label=${qName}]`,
      `textarea[aria-label=${qName}]`,
      `[role="textbox"][aria-label=${qName}]`,
    );
  } else if (cleanRole === 'button') {
    out.unshift(`button[aria-label=${qName}]`, `[role="button"][aria-label=${qName}]`);
  } else if (cleanRole === 'link') {
    out.unshift(`a[aria-label=${qName}]`, `[role="link"][aria-label=${qName}]`);
  }

  out.push(`[aria-label=${qName}]`);
  return uniqStrings(out);
}

// ================================
// SelectorLocator class
// ================================

export class SelectorLocator {
  constructor(private readonly transport: SelectorLocatorTransport) {}

  private async mapHrefToFrameId(
    tabId: number,
    href: string | undefined,
  ): Promise<number | undefined> {
    if (!href || !this.transport.getAllFrames) return undefined;
    try {
      const frames = await this.transport.getAllFrames(tabId);
      const match = frames.find((f) => f.url === href);
      return match?.frameId;
    } catch {
      return undefined;
    }
  }

  private async ensureRef(
    tabId: number,
    request: EnsureRefForSelectorRequest,
    frameId: number | undefined,
  ): Promise<{ ref: string; center: Point; href?: string } | null> {
    const selector = request.selector ?? '';
    const responseRaw = await this.transport.sendMessage(
      tabId,
      request,
      isCompositeSelector(selector) ? undefined : { frameId },
    );
    const parsed = parseEnsureRefResponse(responseRaw);
    if (!parsed || !parsed.success) return null;
    return { ref: parsed.ref, center: parsed.center, href: parsed.href };
  }

  private async resolveRef(
    tabId: number,
    ref: string,
    frameId: number | undefined,
  ): Promise<LocatedElement | null> {
    const msg = { action: TOOL_MESSAGE_TYPES.RESOLVE_REF, ref } satisfies ResolveRefRequest;
    const responseRaw = await this.transport.sendMessage(tabId, msg, { frameId });
    const parsed = parseResolveRefResponse(responseRaw);
    if (!parsed || !parsed.success) return null;
    return { ref, center: parsed.center, frameId, resolvedBy: 'ref' };
  }

  /**
   * Verify whether element matches given fingerprint
   */
  private async verifyElementFingerprint(
    tabId: number,
    ref: string,
    fingerprint: string,
    frameId: number | undefined,
  ): Promise<boolean> {
    const msg = {
      action: TOOL_MESSAGE_TYPES.VERIFY_FINGERPRINT,
      ref,
      fingerprint,
    } satisfies VerifyFingerprintRequest;

    try {
      const responseRaw = await this.transport.sendMessage(tabId, msg, { frameId });
      const parsed = parseVerifyFingerprintResponse(responseRaw);
      if (!parsed || !parsed.success) return false;
      return parsed.match;
    } catch {
      return false;
    }
  }

  /**
   * positioned element
   */
  async locate(
    tabId: number,
    target: SelectorTarget,
    options: SelectorLocateOptions = {},
  ): Promise<LocatedElement | null> {
    const frameSelector = deriveFrameSelector(target);
    const allowMultiple = options.allowMultiple ?? false;

    // Extract fingerprint verification configuration
    const fingerprintToVerify =
      options.verifyFingerprint === true && typeof target.fingerprint === 'string'
        ? target.fingerprint.trim()
        : undefined;

    // Try ref first
    if (options.preferRef && target.ref) {
      const byRef = await this.resolveRef(tabId, target.ref, options.frameId);
      if (byRef) return byRef;
    }

    // 1) Fast path: try target.selector first (assumed CSS / composite CSS)
    if (typeof target.selector === 'string' && target.selector.trim()) {
      const sel = target.selector.trim();
      const ensured = await this.ensureRef(
        tabId,
        { action: TOOL_MESSAGE_TYPES.ENSURE_REF_FOR_SELECTOR, selector: sel, allowMultiple },
        options.frameId,
      );
      if (ensured) {
        const mappedFrameId = await this.mapHrefToFrameId(tabId, ensured.href);
        const resolvedFrameId = mappedFrameId ?? options.frameId;

        // Fingerprint verification: If there is no match, skip it and continue trying other candidates.
        const fingerprintOk =
          !fingerprintToVerify ||
          (await this.verifyElementFingerprint(
            tabId,
            ensured.ref,
            fingerprintToVerify,
            resolvedFrameId,
          ));

        if (fingerprintOk) {
          return {
            ref: ensured.ref,
            center: ensured.center,
            frameId: resolvedFrameId,
            resolvedBy: 'css',
            selectorUsed: sel,
          };
        }
        // Fingerprints do not match, continue trying candidate selectors
      }
    }

    // 2) Candidate ordering (stability + weight). Keep text last by type priority.
    const candidates = [...target.candidates].map(withStability).sort(compareSelectorCandidates);

    for (const candidate of candidates) {
      const resolved = await this.tryCandidate(
        tabId,
        target,
        candidate,
        frameSelector,
        options.frameId,
        allowMultiple,
      );
      if (!resolved) continue;

      // Fingerprint verification
      if (fingerprintToVerify) {
        const isMatch = await this.verifyElementFingerprint(
          tabId,
          resolved.ref,
          fingerprintToVerify,
          resolved.frameId ?? options.frameId,
        );
        if (!isMatch) continue;
      }

      return resolved;
    }

    // 3) Ref fallback
    if (target.ref) {
      const byRef = await this.resolveRef(tabId, target.ref, options.frameId);
      if (byRef) return byRef;
    }

    return null;
  }

  private async tryCandidate(
    tabId: number,
    target: SelectorTarget,
    candidate: SelectorCandidate,
    frameSelector: string | undefined,
    frameId: number | undefined,
    allowMultiple: boolean,
  ): Promise<LocatedElement | null> {
    const tagName = deriveTagNameHint(target, candidate);

    if (candidate.type === 'css' || candidate.type === 'attr') {
      const selectorToTry =
        frameSelector && !isCompositeSelector(candidate.value)
          ? composeCompositeSelector(frameSelector, candidate.value)
          : candidate.value;

      const ensured = await this.ensureRef(
        tabId,
        {
          action: TOOL_MESSAGE_TYPES.ENSURE_REF_FOR_SELECTOR,
          selector: selectorToTry,
          allowMultiple,
        },
        frameId,
      );
      if (!ensured) return null;

      const mappedFrameId = await this.mapHrefToFrameId(tabId, ensured.href);
      return {
        ref: ensured.ref,
        center: ensured.center,
        frameId: mappedFrameId ?? frameId,
        resolvedBy: candidate.type,
        selectorUsed: selectorToTry,
      };
    }

    if (candidate.type === 'xpath') {
      const selectorToTry =
        frameSelector && !isCompositeSelector(candidate.value)
          ? composeCompositeSelector(frameSelector, candidate.value)
          : candidate.value;

      const ensured = await this.ensureRef(
        tabId,
        {
          action: TOOL_MESSAGE_TYPES.ENSURE_REF_FOR_SELECTOR,
          selector: selectorToTry,
          isXPath: true,
          allowMultiple,
        },
        frameId,
      );
      if (!ensured) return null;

      const mappedFrameId = await this.mapHrefToFrameId(tabId, ensured.href);
      return {
        ref: ensured.ref,
        center: ensured.center,
        frameId: mappedFrameId ?? frameId,
        resolvedBy: 'xpath',
        selectorUsed: selectorToTry,
      };
    }

    if (candidate.type === 'aria') {
      const parsed = parseAriaExpr(candidate.value);
      const role = candidate.role ?? parsed.role;
      const name = candidate.name ?? parsed.name;
      const selectors = ariaToCssSelectors(role, name);

      for (const cssSel of selectors) {
        const selectorToTry = frameSelector
          ? composeCompositeSelector(frameSelector, cssSel)
          : cssSel;
        const ensured = await this.ensureRef(
          tabId,
          {
            action: TOOL_MESSAGE_TYPES.ENSURE_REF_FOR_SELECTOR,
            selector: selectorToTry,
            allowMultiple,
          },
          frameId,
        );
        if (!ensured) continue;

        const mappedFrameId = await this.mapHrefToFrameId(tabId, ensured.href);
        return {
          ref: ensured.ref,
          center: ensured.center,
          frameId: mappedFrameId ?? frameId,
          resolvedBy: 'aria',
          selectorUsed: selectorToTry,
        };
      }
      return null;
    }

    // text
    const textValue = candidate.value.trim();
    if (!textValue) return null;

    // NOTE: In composite mode, the helper expects the inner "selector" string to carry the text query.
    const compositeSelector = frameSelector
      ? composeCompositeSelector(frameSelector, textValue)
      : undefined;

    const ensured = await this.ensureRef(
      tabId,
      {
        action: TOOL_MESSAGE_TYPES.ENSURE_REF_FOR_SELECTOR,
        selector: compositeSelector, // for iframe-text: becomes "<frame> |> <text>"
        useText: true,
        text: frameSelector ? undefined : textValue, // non-iframe: use request.text
        tagName: tagName ?? '',
        allowMultiple,
      },
      frameId,
    );

    if (!ensured) return null;

    const mappedFrameId = await this.mapHrefToFrameId(tabId, ensured.href);
    return {
      ref: ensured.ref,
      center: ensured.center,
      frameId: mappedFrameId ?? frameId,
      resolvedBy: 'text',
      selectorUsed: frameSelector ? compositeSelector : textValue,
    };
  }
}

// ================================
// Factory function
// ================================

/**
 * Create a transport layer for Chrome extensions
 */
export function createChromeSelectorLocatorTransport(): SelectorLocatorTransport {
  return {
    sendMessage: async (tabId, message, options) => {
      if (options && typeof options.frameId === 'number') {
        return await chrome.tabs.sendMessage(tabId, message, { frameId: options.frameId });
      }
      return await chrome.tabs.sendMessage(tabId, message);
    },
    getAllFrames: async (tabId) => {
      const frames = await chrome.webNavigation.getAllFrames({ tabId });
      return (frames ?? []).map((f) => ({ frameId: f.frameId, url: f.url ?? '' }));
    },
  };
}

/**
 * Create a selector locator for a Chrome extension
 */
export function createChromeSelectorLocator(): SelectorLocator {
  return new SelectorLocator(createChromeSelectorLocatorTransport());
}
