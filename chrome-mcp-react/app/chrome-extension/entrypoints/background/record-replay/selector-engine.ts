import { TOOL_MESSAGE_TYPES } from '@/common/message-types';
import { TargetLocator, SelectorCandidate } from './types';

// design note: minimal selector engine that tries ref then candidates

export interface LocatedElement {
  ref?: string;
  center?: { x: number; y: number };
  resolvedBy?: 'ref' | SelectorCandidate['type'];
  frameId?: number;
}

// Helper: decide whether selector is a composite cross-frame selector
function isCompositeSelector(sel: string): boolean {
  return typeof sel === 'string' && sel.includes('|>');
}

// Helper: typed wrapper for chrome.tabs.sendMessage with optional frameId
async function sendToTab(tabId: number, message: any, frameId?: number): Promise<any> {
  if (typeof frameId === 'number') {
    return await chrome.tabs.sendMessage(tabId, message, { frameId });
  }
  return await chrome.tabs.sendMessage(tabId, message);
}

// Helper: ensure ref for a selector, handling composite selectors and mapping frameId
async function ensureRefForSelector(
  tabId: number,
  selector: string,
  frameId?: number,
): Promise<{ ref: string; center: { x: number; y: number }; frameId?: number } | null> {
  try {
    let ensured: any = null;
    if (isCompositeSelector(selector)) {
      // Always query top for composite; helper will bridge to child and return href
      ensured = await sendToTab(tabId, {
        action: TOOL_MESSAGE_TYPES.ENSURE_REF_FOR_SELECTOR,
        selector,
      });
    } else {
      ensured = await sendToTab(
        tabId,
        { action: TOOL_MESSAGE_TYPES.ENSURE_REF_FOR_SELECTOR, selector },
        frameId,
      );
    }
    if (!ensured || !ensured.success || !ensured.ref || !ensured.center) return null;
    // Map frameId when composite via returned href
    let locFrameId: number | undefined = undefined;
    if (isCompositeSelector(selector) && ensured.href) {
      try {
        const frames = (await chrome.webNavigation.getAllFrames({ tabId })) as any[];
        const match = frames?.find((f) => typeof f.url === 'string' && f.url === ensured.href);
        if (match) locFrameId = match.frameId;
      } catch {}
    }
    return { ref: ensured.ref, center: ensured.center, frameId: locFrameId };
  } catch {
    return null;
  }
}

/**
 * Try to resolve an element using ref or candidates via content scripts
 */
export async function locateElement(
  tabId: number,
  target: TargetLocator,
  frameId?: number,
): Promise<LocatedElement | null> {
  // 0) Fast path: try primary selector if provided
  const primarySel = (target as any)?.selector ? String((target as any).selector).trim() : '';
  if (primarySel) {
    const ensured = await ensureRefForSelector(tabId, primarySel, frameId);
    if (ensured) return { ...ensured, resolvedBy: 'css' };
  }

  // 1) Non-text candidates first for stability (css/attr/aria/xpath)
  const nonText = (target.candidates || []).filter((c) => c.type !== 'text');
  for (const c of nonText) {
    try {
      if (c.type === 'css' || c.type === 'attr') {
        const ensured = await ensureRefForSelector(tabId, String(c.value || ''), frameId);
        if (ensured) return { ...ensured, resolvedBy: c.type };
      } else if (c.type === 'aria') {
        // Minimal ARIA role+name parser like: "button[name=提交]" or "textbox[name=用户名]"
        const v = String(c.value || '').trim();
        const m = v.match(/^(\w+)\s*\[\s*name\s*=\s*([^\]]+)\]$/);
        const role = m ? m[1] : '';
        const name = m ? m[2] : '';
        const cleanName = name.replace(/^['"]|['"]$/g, '');
        const ariaSelectors: string[] = [];
        if (role === 'textbox') {
          ariaSelectors.push(
            `[role="textbox"][aria-label=${JSON.stringify(cleanName)}]`,
            `input[aria-label=${JSON.stringify(cleanName)}]`,
            `textarea[aria-label=${JSON.stringify(cleanName)}]`,
          );
        } else if (role === 'button') {
          ariaSelectors.push(
            `[role="button"][aria-label=${JSON.stringify(cleanName)}]`,
            `button[aria-label=${JSON.stringify(cleanName)}]`,
          );
        } else if (role === 'link') {
          ariaSelectors.push(
            `[role="link"][aria-label=${JSON.stringify(cleanName)}]`,
            `a[aria-label=${JSON.stringify(cleanName)}]`,
          );
        }
        if (!ariaSelectors.length && role) {
          ariaSelectors.push(
            `[role=${JSON.stringify(role)}][aria-label=${JSON.stringify(cleanName)}]`,
          );
        }
        for (const sel of ariaSelectors) {
          const ensured = await sendToTab(
            tabId,
            { action: TOOL_MESSAGE_TYPES.ENSURE_REF_FOR_SELECTOR, selector: sel } as any,
            frameId,
          );
          if (ensured && ensured.success && ensured.ref && ensured.center) {
            return { ref: ensured.ref, center: ensured.center, resolvedBy: c.type, frameId };
          }
        }
      } else if (c.type === 'xpath') {
        // Minimal xpath support via document.evaluate through injected helper
        const ensured = await sendToTab(
          tabId,
          {
            action: TOOL_MESSAGE_TYPES.ENSURE_REF_FOR_SELECTOR,
            selector: c.value,
            isXPath: true,
          } as any,
          frameId,
        );
        if (ensured && ensured.success && ensured.ref && ensured.center) {
          return { ref: ensured.ref, center: ensured.center, resolvedBy: c.type, frameId };
        }
      }
    } catch (e) {
      // continue to next candidate
    }
  }
  // 2) Human-intent fallback: text-based search as last resort
  const textCands = (target.candidates || []).filter((c) => c.type === 'text');
  const tagName = ((target as any)?.tag || '').toString();
  for (const c of textCands) {
    try {
      const ensured = await sendToTab(
        tabId,
        {
          action: TOOL_MESSAGE_TYPES.ENSURE_REF_FOR_SELECTOR,
          useText: true,
          text: c.value,
          tagName,
        } as any,
        frameId,
      );
      if (ensured && ensured.success && ensured.ref && ensured.center) {
        return { ref: ensured.ref, center: ensured.center, resolvedBy: c.type };
      }
    } catch {}
  }
  // Fallback: try ref (works when ref was produced in the same page lifecycle)
  if (target.ref) {
    try {
      const res = await sendToTab(
        tabId,
        { action: TOOL_MESSAGE_TYPES.RESOLVE_REF, ref: target.ref } as any,
        frameId,
      );
      if (res && res.success && res.center) {
        return { ref: target.ref, center: res.center, resolvedBy: 'ref' };
      }
    } catch (e) {
      // ignore
    }
  }
  return null;
}

/**
 * Ensure screenshot context hostname is still valid for coordinate-based actions
 */
// Note: screenshot hostname validation is handled elsewhere; removed legacy stub.
