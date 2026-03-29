import type { ExecutionFlags } from "./actions/types";

export const PUBLIC_FLOW_OPEN_URL_ERROR =
  "Public flow runs can only open HTTP(S) URLs. Omit the url for a blank tab or use an HTTP(S) page.";
export const PUBLIC_FLOW_SWITCH_TAB_ERROR =
  "Public flow runs can only switch to HTTP(S) tabs.";
export const PUBLIC_FLOW_RUN_TARGET_ERROR =
  "Public flow runs only support HTTP(S) tabs. Switch to an HTTP(S) page or provide an HTTP(S) startUrl.";

export function enforcesPublicPageRestrictions(
  execution?: ExecutionFlags,
): boolean {
  return execution?.disallowLocalFilePages === true;
}

export function isHttpUrl(url?: string | null): boolean {
  return typeof url === "string" && /^https?:/i.test(url.trim());
}

export function isAboutBlankUrl(url?: string | null): boolean {
  return typeof url === "string" && /^about:blank(?:$|[?#])/i.test(url.trim());
}

export function isAllowedPublicFlowOpenUrl(url?: string | null): boolean {
  if (typeof url !== "string" || !url.trim()) {
    return true;
  }
  return isHttpUrl(url) || isAboutBlankUrl(url);
}

export function isAllowedPublicFlowTabUrl(url?: string | null): boolean {
  return isHttpUrl(url);
}
