import { Buffer } from "node:buffer";
import { createHash, createPublicKey } from "node:crypto";
import process from "node:process";

export const EXTENSION_PUBLIC_KEY_ENV = "CHROME_EXTENSION_PUBLIC_KEY";
export const EXTENSION_EXPECTED_ID_ENV = "CHROME_EXTENSION_EXPECTED_ID";
export const LEGACY_EXTENSION_KEY_ENV = "CHROME_EXTENSION_KEY";
export const REQUIRE_EXTENSION_PUBLIC_KEY_ENV =
  "WEBPAGE_MCP_REQUIRE_EXTENSION_PUBLIC_KEY";

const MAX_ENCODED_KEY_LENGTH = 16 * 1024;
const BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const PLACEHOLDER_PATTERN =
  /^(?:YOUR|REPLACE|INSERT|EXAMPLE|TODO)(?:[_-].*)?$/i;
const EXTENSION_ID_PATTERN = /^[a-p]{32}$/;
const EXTENSION_ID_ALPHABET = "abcdefghijklmnop";

function fail(message) {
  throw new Error(`[extension-public-key] ${message}`);
}

function parseRequiredFlag(rawValue) {
  if (rawValue === undefined || rawValue === "") return false;
  if (typeof rawValue !== "string") {
    fail(`${REQUIRE_EXTENSION_PUBLIC_KEY_ENV} must be a boolean string`);
  }

  const normalized = rawValue.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") return true;
  if (normalized === "false" || normalized === "0") return false;
  fail(
    `${REQUIRE_EXTENSION_PUBLIC_KEY_ENV} must be true, false, 1, or 0; received ${JSON.stringify(rawValue)}`,
  );
}

export function validateChromeExtensionPublicKey(rawValue) {
  if (typeof rawValue !== "string" || rawValue.length === 0) {
    fail(`${EXTENSION_PUBLIC_KEY_ENV} must be a non-empty string`);
  }
  if (rawValue.length > MAX_ENCODED_KEY_LENGTH) {
    fail(
      `${EXTENSION_PUBLIC_KEY_ENV} exceeds the ${MAX_ENCODED_KEY_LENGTH}-character limit`,
    );
  }
  if (
    /-----BEGIN|-----END|PRIVATE KEY|PUBLIC KEY/i.test(rawValue) ||
    PLACEHOLDER_PATTERN.test(rawValue)
  ) {
    fail(
      `${EXTENSION_PUBLIC_KEY_ENV} must contain the Chrome Web Store public-key body, never PEM text, a private key, or a placeholder`,
    );
  }
  if (rawValue !== rawValue.trim() || /\s/.test(rawValue)) {
    fail(
      `${EXTENSION_PUBLIC_KEY_ENV} must be a single-line base64 DER value without whitespace`,
    );
  }
  if (!BASE64_PATTERN.test(rawValue)) {
    fail(`${EXTENSION_PUBLIC_KEY_ENV} is not canonical base64`);
  }

  const der = Buffer.from(rawValue, "base64");
  if (der.length === 0 || der.toString("base64") !== rawValue) {
    fail(`${EXTENSION_PUBLIC_KEY_ENV} is not canonical base64 DER`);
  }

  let publicKey;
  try {
    publicKey = createPublicKey({ key: der, format: "der", type: "spki" });
  } catch {
    fail(
      `${EXTENSION_PUBLIC_KEY_ENV} must be a DER-encoded SubjectPublicKeyInfo public key`,
    );
  }
  if (publicKey.asymmetricKeyType !== "rsa") {
    fail(`${EXTENSION_PUBLIC_KEY_ENV} must contain an RSA public key`);
  }

  const normalizedDer = publicKey.export({ format: "der", type: "spki" });
  if (!Buffer.isBuffer(normalizedDer) || !normalizedDer.equals(der)) {
    fail(
      `${EXTENSION_PUBLIC_KEY_ENV} must use canonical DER SubjectPublicKeyInfo encoding`,
    );
  }
  return rawValue;
}

export function deriveChromeExtensionId(publicKeyValue) {
  const publicKey = validateChromeExtensionPublicKey(publicKeyValue);
  const digest = createHash("sha256")
    .update(Buffer.from(publicKey, "base64"))
    .digest();
  let extensionId = "";
  for (const byte of digest.subarray(0, 16)) {
    extensionId += EXTENSION_ID_ALPHABET[byte >> 4];
    extensionId += EXTENSION_ID_ALPHABET[byte & 0x0f];
  }
  return extensionId;
}

export function resolveChromeExtensionPublicKey(environment = process.env) {
  const legacyValue = environment[LEGACY_EXTENSION_KEY_ENV];
  if (legacyValue !== undefined && legacyValue !== "") {
    fail(
      `${LEGACY_EXTENSION_KEY_ENV} is rejected because its old name encouraged private-key use; configure the public-only ${EXTENSION_PUBLIC_KEY_ENV} instead`,
    );
  }

  const required = parseRequiredFlag(
    environment[REQUIRE_EXTENSION_PUBLIC_KEY_ENV],
  );
  const rawValue = environment[EXTENSION_PUBLIC_KEY_ENV];
  const expectedExtensionId = environment[EXTENSION_EXPECTED_ID_ENV];
  if (rawValue === undefined || rawValue === "") {
    if (
      required ||
      (expectedExtensionId !== undefined && expectedExtensionId !== "")
    ) {
      fail(
        `${EXTENSION_PUBLIC_KEY_ENV} is required for a formal release so the unpacked artifact keeps its stable extension ID`,
      );
    }
    return undefined;
  }

  const publicKey = validateChromeExtensionPublicKey(rawValue);
  if (expectedExtensionId !== undefined && expectedExtensionId !== "") {
    if (!EXTENSION_ID_PATTERN.test(expectedExtensionId)) {
      fail(
        `${EXTENSION_EXPECTED_ID_ENV} must be a 32-character Chrome extension ID`,
      );
    }
    if (deriveChromeExtensionId(publicKey) !== expectedExtensionId) {
      fail(
        `${EXTENSION_PUBLIC_KEY_ENV} does not derive the ${EXTENSION_EXPECTED_ID_ENV} identity`,
      );
    }
  } else if (required) {
    fail(
      `${EXTENSION_EXPECTED_ID_ENV} is required when ${REQUIRE_EXTENSION_PUBLIC_KEY_ENV}=true`,
    );
  }

  return publicKey;
}
