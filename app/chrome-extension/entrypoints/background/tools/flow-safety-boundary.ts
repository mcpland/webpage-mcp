export interface WorkflowStabilizeValidationError {
  code: string;
  path: string;
  message: string;
}

export interface StabilizeSafetyBoundary {
  allowedHosts: string[];
  origins: string[];
  pathPrefixes: string[];
}

export function normalizeBoundaryStrings(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item): item is string => item.length > 0);
}

function hostMatchesBoundary(host: string, allowedHost: string): boolean {
  const normalizedHost = host.toLowerCase();
  const normalizedAllowed = allowedHost.toLowerCase();
  return (
    normalizedHost === normalizedAllowed ||
    normalizedHost.endsWith(`.${normalizedAllowed}`)
  );
}

function pathMatchesBoundary(pathname: string, prefix: string): boolean {
  if (!prefix.startsWith("/")) return false;
  const normalizedPrefix = prefix.replace(/\/+$/, "") || "/";
  return (
    normalizedPrefix === "/" ||
    pathname === normalizedPrefix ||
    pathname.startsWith(`${normalizedPrefix}/`)
  );
}

export function isAllowedPublicStartUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return false;
  }

  return parsed.protocol === "http:" || parsed.protocol === "https:";
}

export function getStabilizeSafetyBoundary(args: any): StabilizeSafetyBoundary {
  const allowedHosts = normalizeBoundaryStrings(args?.safety?.allowedHosts);
  const testEnvironment =
    args?.safety?.testEnvironment &&
    typeof args.safety.testEnvironment === "object" &&
    !Array.isArray(args.safety.testEnvironment)
      ? args.safety.testEnvironment
      : undefined;
  const origins = normalizeBoundaryStrings(testEnvironment?.origins);
  const pathPrefixes = normalizeBoundaryStrings(testEnvironment?.pathPrefixes);
  return { allowedHosts, origins, pathPrefixes };
}

export function hasStabilizeUrlBoundary(
  boundary: StabilizeSafetyBoundary,
): boolean {
  return (
    boundary.allowedHosts.length > 0 ||
    boundary.origins.length > 0 ||
    boundary.pathPrefixes.length > 0
  );
}

export function validateUrlAgainstStabilizeBoundary(
  url: string,
  boundary: StabilizeSafetyBoundary,
  path: string,
  label: string,
): WorkflowStabilizeValidationError | undefined {
  if (!hasStabilizeUrlBoundary(boundary)) {
    return undefined;
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return {
      code: path === "/startUrl" ? "INVALID_START_URL" : "INVALID_REPLAY_URL",
      path,
      message: `${label} must be an absolute URL`,
    };
  }

  const originAllowed =
    boundary.origins.length === 0 ||
    boundary.origins.some(
      (origin) => origin.replace(/\/+$/, "") === parsed.origin,
    );
  const hostAllowed =
    boundary.allowedHosts.length === 0 ||
    boundary.allowedHosts.some((host) =>
      hostMatchesBoundary(parsed.hostname, host),
    );
  const pathAllowed =
    boundary.pathPrefixes.length === 0 ||
    boundary.pathPrefixes.some((prefix) =>
      pathMatchesBoundary(parsed.pathname, prefix),
    );
  if (!originAllowed || !hostAllowed || !pathAllowed) {
    return {
      code:
        path === "/startUrl"
          ? "START_URL_OUTSIDE_TEST_ENVIRONMENT"
          : "REPLAY_URL_OUTSIDE_TEST_ENVIRONMENT",
      path,
      message: `${label} is outside the declared safety boundary: ${parsed.origin}${parsed.pathname}`,
    };
  }
  return undefined;
}
