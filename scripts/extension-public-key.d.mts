export const EXTENSION_PUBLIC_KEY_ENV: "CHROME_EXTENSION_PUBLIC_KEY";
export const EXTENSION_EXPECTED_ID_ENV: "CHROME_EXTENSION_EXPECTED_ID";
export const LEGACY_EXTENSION_KEY_ENV: "CHROME_EXTENSION_KEY";
export const REQUIRE_EXTENSION_PUBLIC_KEY_ENV: "WEBPAGE_MCP_REQUIRE_EXTENSION_PUBLIC_KEY";

export function validateChromeExtensionPublicKey(rawValue: unknown): string;

export function deriveChromeExtensionId(publicKeyValue: unknown): string;

export function resolveChromeExtensionPublicKey(
  environment?: Record<string, string | undefined>,
): string | undefined;
