import { Buffer } from "node:buffer";
import { createHash, createPublicKey } from "node:crypto";

const MAX_ENCODED_KEY_LENGTH = 16 * 1024;
const BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const PLACEHOLDER_PATTERN =
  /^(?:YOUR|REPLACE|INSERT|EXAMPLE|TODO)(?:[_-].*)?$/i;
const EXTENSION_ID_ALPHABET = "abcdefghijklmnop";

function fail(message) {
  throw new Error(`[extension-public-key] ${message}`);
}

export function validateChromeExtensionPublicKey(rawValue) {
  if (typeof rawValue !== "string" || rawValue.length === 0) {
    fail("extension public key must be a non-empty string");
  }
  if (rawValue.length > MAX_ENCODED_KEY_LENGTH) {
    fail(
      `extension public key exceeds the ${MAX_ENCODED_KEY_LENGTH}-character limit`,
    );
  }
  if (
    /-----BEGIN|-----END|PRIVATE KEY|PUBLIC KEY/i.test(rawValue) ||
    PLACEHOLDER_PATTERN.test(rawValue)
  ) {
    fail(
      "extension public key must contain a public-key body, never PEM text, a private key, or a placeholder",
    );
  }
  if (rawValue !== rawValue.trim() || /\s/.test(rawValue)) {
    fail(
      "extension public key must be a single-line base64 DER value without whitespace",
    );
  }
  if (!BASE64_PATTERN.test(rawValue)) {
    fail("extension public key is not canonical base64");
  }

  const der = Buffer.from(rawValue, "base64");
  if (der.length === 0 || der.toString("base64") !== rawValue) {
    fail("extension public key is not canonical base64 DER");
  }

  let publicKey;
  try {
    publicKey = createPublicKey({ key: der, format: "der", type: "spki" });
  } catch {
    fail(
      "extension public key must be a DER-encoded SubjectPublicKeyInfo public key",
    );
  }
  if (publicKey.asymmetricKeyType !== "rsa") {
    fail("extension public key must contain an RSA public key");
  }

  const normalizedDer = publicKey.export({ format: "der", type: "spki" });
  if (!Buffer.isBuffer(normalizedDer) || !normalizedDer.equals(der)) {
    fail(
      "extension public key must use canonical DER SubjectPublicKeyInfo encoding",
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
