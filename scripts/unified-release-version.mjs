const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const MAX_CHROME_VERSION_COMPONENT = 65_535;

/**
 * Validate the one version shared by the Chrome extension and npm package.
 *
 * Chrome's update version is numeric and cannot safely represent a SemVer
 * prerelease on the same x.y.z base. The unified release therefore accepts
 * exact stable x.y.z versions only; npm-only prerelease channels are separate.
 */
export function validateUnifiedReleaseVersion(
  value,
  description = "Unified release version",
) {
  if (typeof value !== "string") {
    throw new Error(
      `${description} must be a stable x.y.z string; received: ${String(value)}`,
    );
  }

  const match = SEMVER_PATTERN.exec(value);
  if (!match) {
    throw new Error(
      `${description} must use canonical semantic version form x.y.z; received: ${value}`,
    );
  }
  if (match[4] !== undefined) {
    throw new Error(
      `${description}: prerelease versions are not supported by the unified Chrome/npm release; received: ${value}`,
    );
  }
  if (match[5] !== undefined) {
    throw new Error(
      `${description}: build metadata is not supported by the unified Chrome/npm release; received: ${value}`,
    );
  }

  const components = match.slice(1, 4).map(Number);
  if (components.every((component) => component === 0)) {
    throw new Error(
      `${description} cannot be 0.0.0 because Chrome requires a non-zero version component`,
    );
  }
  if (
    components.some((component) => component > MAX_CHROME_VERSION_COMPONENT)
  ) {
    throw new Error(
      `${description} must keep every Chrome version component between 0 and ${MAX_CHROME_VERSION_COMPONENT}; received: ${value}`,
    );
  }

  return value;
}
