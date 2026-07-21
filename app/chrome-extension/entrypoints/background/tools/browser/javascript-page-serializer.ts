/**
 * This function is sent to Runtime.callFunctionOn and therefore must remain
 * completely self-contained. It serializes the value retained by the remote
 * holder without first cloning that value into the extension process.
 */

export interface JavaScriptEvaluationHolder {
  __webpageMcpStatus: 0 | 1;
  __webpageMcpValue: unknown;
}

export type PageSerializationEnvelope =
  | {
      version: 1;
      status: "success";
      text: string;
      truncated: boolean;
      redacted: boolean;
    }
  | {
      version: 1;
      status: "error";
      errorKind: "syntax_error" | "runtime_error" | "serialization_error";
      message: string;
    };

export function serializeJavaScriptEvaluation(
  this: JavaScriptEvaluationHolder,
  requestedMaxOutputBytes: number,
): PageSerializationEnvelope {
  try {
    // These literals deliberately duplicate the public hard ceiling. The
    // remote function cannot close over imported extension constants.
    const MIN_OUTPUT_BYTES = 1;
    const MAX_OUTPUT_BYTES = 1024 * 1024;
    const MAX_DEPTH = 6;
    const MAX_ARRAY_LENGTH = 200;
    const MAX_OBJECT_KEYS = 200;
    const MAX_STRING_LENGTH = 10_000;
    const MAX_KEY_LENGTH = 512;
    const MAX_VISITED_VALUES = 4096;
    const MAX_CHUNK_CHARS = 4096;
    const MAX_SERIALIZABLE_BIGINT = 10n ** 4096n;

    const requestedInteger =
      typeof requestedMaxOutputBytes === "number" &&
      requestedMaxOutputBytes === requestedMaxOutputBytes
        ? requestedMaxOutputBytes | 0
        : 50 * 1024;
    const maxOutputBytes =
      requestedInteger < MIN_OUTPUT_BYTES
        ? MIN_OUTPUT_BYTES
        : requestedInteger > MAX_OUTPUT_BYTES
          ? MAX_OUTPUT_BYTES
          : requestedInteger;

    const sensitiveKeyMarkers = [
      "cookie",
      "setcookie",
      "authorization",
      "proxyauthorization",
      "bearer",
      "token",
      "accesstoken",
      "refreshtoken",
      "idtoken",
      "password",
      "passwd",
      "pwd",
      "secret",
      "clientsecret",
      "apikey",
      "session",
      "sessionid",
      "sid",
      "csrf",
      "xsrf",
      "credential",
      "privatekey",
      "accesskey",
      "auth",
      "oauth",
    ];

    const uppercase = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const lowercase = "abcdefghijklmnopqrstuvwxyz";
    const controlCharacters =
      "\u0000\u0001\u0002\u0003\u0004\u0005\u0006\u0007\u0008\u0009\u000a\u000b\u000c\u000d\u000e\u000f" +
      "\u0010\u0011\u0012\u0013\u0014\u0015\u0016\u0017\u0018\u0019\u001a\u001b\u001c\u001d\u001e\u001f";

    const manualCharacterIndex = (text: string, character: string): number => {
      for (let index = 0; index < text.length; index += 1) {
        if (text[index] === character) return index;
      }
      return -1;
    };

    const lowerAsciiCharacter = (character: string): string => {
      const index = manualCharacterIndex(uppercase, character);
      return index >= 0 ? lowercase[index] : character;
    };

    const charactersEqual = (
      left: string,
      right: string,
      ignoreAsciiCase: boolean,
    ): boolean => {
      if (left === right) return true;
      if (!ignoreAsciiCase) return false;
      const leftUpperIndex = manualCharacterIndex(uppercase, left);
      if (leftUpperIndex >= 0) return lowercase[leftUpperIndex] === right;
      const rightUpperIndex = manualCharacterIndex(uppercase, right);
      return rightUpperIndex >= 0 && lowercase[rightUpperIndex] === left;
    };

    const matchesAt = (
      text: string,
      needle: string,
      start: number,
      ignoreAsciiCase = false,
    ): boolean => {
      if (start < 0 || start + needle.length > text.length) return false;
      for (let index = 0; index < needle.length; index += 1) {
        if (
          !charactersEqual(text[start + index], needle[index], ignoreAsciiCase)
        ) {
          return false;
        }
      }
      return true;
    };

    const containsText = (
      text: string,
      needle: string,
      ignoreAsciiCase = false,
    ): boolean => {
      for (let index = 0; index + needle.length <= text.length; index += 1) {
        if (matchesAt(text, needle, index, ignoreAsciiCase)) return true;
      }
      return false;
    };

    const copyRange = (text: string, start: number, end: number): string => {
      let result = "";
      const boundedStart = start > 0 ? start : 0;
      const boundedEnd = end < text.length ? end : text.length;
      for (let index = boundedStart; index < boundedEnd; index += 1) {
        result += text[index];
      }
      return result;
    };

    const conservativeUtf8UnitBytes = (character: string): number =>
      character >= "\u0000" && character <= "\u007f" ? 1 : 3;

    const utf8ByteLength = (text: string): number => {
      let bytes = 0;
      for (let index = 0; index < text.length; index += 1) {
        bytes += conservativeUtf8UnitBytes(text[index]);
      }
      return bytes;
    };

    const takeUtf8Prefix = (
      text: string,
      maximumBytes: number,
    ): { text: string; bytes: number } => {
      let bytes = 0;
      let result = "";
      for (let index = 0; index < text.length; index += 1) {
        const character = text[index];
        const nextBytes = conservativeUtf8UnitBytes(character);
        if (bytes + nextBytes > maximumBytes) break;
        result += character;
        bytes += nextBytes;
      }
      return { text: result, bytes };
    };

    const isWhitespace = (character: string): boolean =>
      character === " " ||
      character === "\t" ||
      character === "\n" ||
      character === "\r" ||
      character === "\f";

    const isAsciiAlphaNumeric = (character: string): boolean =>
      (character >= "a" && character <= "z") ||
      (character >= "A" && character <= "Z") ||
      (character >= "0" && character <= "9");

    const isBase64Character = (character: string): boolean =>
      isAsciiAlphaNumeric(character) ||
      character === "+" ||
      character === "/" ||
      character === "=";

    const isBase64UrlCharacter = (character: string): boolean =>
      isAsciiAlphaNumeric(character) || character === "_" || character === "-";

    const isHexCharacter = (character: string): boolean => {
      const lower = lowerAsciiCharacter(character);
      return (
        (lower >= "a" && lower <= "f") || (character >= "0" && character <= "9")
      );
    };

    const isWholeEncodedString = (
      text: string,
      minimumLength: number,
      hexOnly: boolean,
    ): boolean => {
      if (text.length < minimumLength) return false;
      for (let index = 0; index < text.length; index += 1) {
        if (
          hexOnly
            ? !isHexCharacter(text[index])
            : !isBase64Character(text[index])
        ) {
          return false;
        }
      }
      return true;
    };

    const looksLikePairString = (text: string, separator: string): boolean => {
      let pairs = 0;
      let segmentStart = 0;
      for (let index = 0; index < text.length; index += 1) {
        const character = text[index];
        if (character === "=" && index > segmentStart) pairs += 1;
        if (character === separator) segmentStart = index + 1;
      }
      return pairs >= 2 && containsText(text, separator);
    };

    const isTokenCharacter = (character: string): boolean =>
      isAsciiAlphaNumeric(character) ||
      character === "." ||
      character === "_" ||
      character === "~" ||
      character === "+" ||
      character === "/" ||
      character === "=" ||
      character === "-";

    const redactBearerTokens = (
      text: string,
    ): { text: string; changed: boolean } => {
      let result = "";
      let changed = false;
      let index = 0;
      while (index < text.length) {
        const boundaryBefore =
          index === 0 || !isAsciiAlphaNumeric(text[index - 1]);
        if (
          boundaryBefore &&
          matchesAt(text, "bearer", index, true) &&
          isWhitespace(text[index + 6] || "")
        ) {
          result += copyRange(text, index, index + 6);
          let cursor = index + 6;
          while (cursor < text.length && isWhitespace(text[cursor])) {
            result += text[cursor];
            cursor += 1;
          }
          const tokenStart = cursor;
          while (cursor < text.length && isTokenCharacter(text[cursor])) {
            cursor += 1;
          }
          if (cursor > tokenStart) {
            result += "<redacted>";
            changed = true;
            index = cursor;
            continue;
          }
        }
        result += text[index];
        index += 1;
      }
      return { text: result, changed };
    };

    const redactJwtTokens = (
      text: string,
    ): { text: string; changed: boolean } => {
      let result = "";
      let changed = false;
      let index = 0;
      while (index < text.length) {
        const boundaryBefore =
          index === 0 || !isBase64UrlCharacter(text[index - 1]);
        if (boundaryBefore) {
          let firstEnd = index;
          while (
            firstEnd < text.length &&
            isBase64UrlCharacter(text[firstEnd])
          ) {
            firstEnd += 1;
          }
          let secondEnd = firstEnd + 1;
          while (
            secondEnd < text.length &&
            isBase64UrlCharacter(text[secondEnd])
          ) {
            secondEnd += 1;
          }
          let thirdEnd = secondEnd + 1;
          while (
            thirdEnd < text.length &&
            isBase64UrlCharacter(text[thirdEnd])
          ) {
            thirdEnd += 1;
          }
          if (
            firstEnd - index >= 10 &&
            text[firstEnd] === "." &&
            secondEnd - firstEnd - 1 >= 10 &&
            text[secondEnd] === "." &&
            thirdEnd - secondEnd - 1 >= 10
          ) {
            result += "<redacted_jwt>";
            changed = true;
            index = thirdEnd;
            continue;
          }
        }
        result += text[index];
        index += 1;
      }
      return { text: result, changed };
    };

    const assignmentMarkers = [
      "authorization",
      "set-cookie",
      "x-api-key",
      "access_token",
      "refresh_token",
      "id_token",
      "private_key",
      "credential",
      "password",
      "passwd",
      "apikey",
      "api_key",
      "session",
      "secret",
      "cookie",
      "oauth",
      "token",
      "auth",
      "pwd",
      "sid",
    ];

    const redactAssignments = (
      text: string,
    ): { text: string; changed: boolean } => {
      let result = "";
      let changed = false;
      let index = 0;
      while (index < text.length) {
        let markerLength = 0;
        for (
          let markerIndex = 0;
          markerIndex < assignmentMarkers.length;
          markerIndex += 1
        ) {
          const marker = assignmentMarkers[markerIndex];
          const boundaryBefore =
            index === 0 ||
            (!isAsciiAlphaNumeric(text[index - 1]) && text[index - 1] !== "_");
          const after = text[index + marker.length] || "";
          if (
            boundaryBefore &&
            matchesAt(text, marker, index, true) &&
            !isAsciiAlphaNumeric(after) &&
            after !== "_"
          ) {
            markerLength = marker.length;
            break;
          }
        }
        if (markerLength === 0) {
          result += text[index];
          index += 1;
          continue;
        }

        let cursor = index + markerLength;
        if (text[cursor] === '"' || text[cursor] === "'") cursor += 1;
        while (cursor < text.length && isWhitespace(text[cursor])) cursor += 1;
        if (text[cursor] !== ":" && text[cursor] !== "=") {
          result += text[index];
          index += 1;
          continue;
        }
        cursor += 1;
        while (cursor < text.length && isWhitespace(text[cursor])) cursor += 1;
        const quote =
          text[cursor] === '"' || text[cursor] === "'" ? text[cursor] : "";
        if (quote) cursor += 1;
        result += copyRange(text, index, cursor);
        result += "<redacted>";
        changed = true;

        if (quote) {
          let escaped = false;
          while (cursor < text.length) {
            const character = text[cursor];
            if (character === quote && !escaped) {
              result += quote;
              cursor += 1;
              break;
            }
            if (character === "\\" && !escaped) escaped = true;
            else escaped = false;
            cursor += 1;
          }
        } else {
          while (
            cursor < text.length &&
            !isWhitespace(text[cursor]) &&
            text[cursor] !== "," &&
            text[cursor] !== ";" &&
            text[cursor] !== "&" &&
            text[cursor] !== "#" &&
            text[cursor] !== '"' &&
            text[cursor] !== "'"
          ) {
            cursor += 1;
          }
        }
        index = cursor;
      }
      return { text: result, changed };
    };

    const redactLongEncodedRuns = (
      text: string,
    ): { text: string; changed: boolean } => {
      let result = "";
      let changed = false;
      let index = 0;
      while (index < text.length) {
        if (!isBase64Character(text[index])) {
          result += text[index];
          index += 1;
          continue;
        }
        let end = index;
        let allHex = true;
        while (end < text.length && isBase64Character(text[end])) {
          if (!isHexCharacter(text[end])) allHex = false;
          end += 1;
        }
        if (end - index >= 40) {
          result += allHex ? "<redacted_hex>" : "<redacted_base64>";
          changed = true;
        } else {
          result += copyRange(text, index, end);
        }
        index = end;
      }
      return { text: result, changed };
    };

    const sanitizeBoundedText = (
      input: string,
      maximumCharacters: number,
    ): { text: string; redacted: boolean; truncated: boolean } => {
      const inputWasTruncated = input.length > maximumCharacters;
      let out = copyRange(input, 0, maximumCharacters);
      let redacted = false;

      if (looksLikePairString(out, ";") || looksLikePairString(out, "&")) {
        return {
          text: "[BLOCKED: Cookie/query string data]",
          redacted: true,
          truncated: inputWasTruncated,
        };
      }
      if (isWholeEncodedString(out, 20, false)) {
        return {
          text: "[BLOCKED: Base64 encoded data]",
          redacted: true,
          truncated: inputWasTruncated,
        };
      }
      if (isWholeEncodedString(out, 32, true)) {
        return {
          text: "[BLOCKED: Hex credential]",
          redacted: true,
          truncated: inputWasTruncated,
        };
      }

      const bearer = redactBearerTokens(out);
      out = bearer.text;
      redacted = redacted || bearer.changed;
      const jwt = redactJwtTokens(out);
      out = jwt.text;
      redacted = redacted || jwt.changed;
      const assignments = redactAssignments(out);
      out = assignments.text;
      redacted = redacted || assignments.changed;
      const encoded = redactLongEncodedRuns(out);
      out = encoded.text;
      redacted = redacted || encoded.changed;

      if (inputWasTruncated) {
        out = `${out}... [truncated ${input.length - maximumCharacters} chars]`;
      }
      return { text: out, redacted, truncated: inputWasTruncated };
    };

    const normalizeKey = (key: string): string => {
      let normalized = "";
      for (let index = 0; index < key.length; index += 1) {
        const character = lowerAsciiCharacter(key[index]);
        if (
          (character >= "a" && character <= "z") ||
          (character >= "0" && character <= "9")
        ) {
          normalized += character;
        }
      }
      return normalized;
    };

    const isSensitiveKey = (key: string): boolean => {
      if (key.length > MAX_KEY_LENGTH) return true;
      const normalized = normalizeKey(key);
      for (let index = 0; index < sensitiveKeyMarkers.length; index += 1) {
        if (containsText(normalized, sensitiveKeyMarkers[index])) return true;
      }
      return false;
    };

    const chunks: string[] = [];
    const seen: object[] = [];
    let outputBytes = 0;
    let visitedValues = 0;
    let nodeLimitReached = false;
    let redacted = false;
    let truncated = false;
    let byteTruncated = false;
    let stopped = false;

    const pushChunk = (value: string): void => {
      if (!value) return;
      const lastIndex = chunks.length - 1;
      const previous = chunks[lastIndex];
      if (
        previous !== undefined &&
        previous.length + value.length <= MAX_CHUNK_CHARS
      ) {
        chunks[lastIndex] = previous + value;
      } else {
        chunks[chunks.length] = value;
      }
    };

    const append = (value: string): boolean => {
      if (stopped) return false;
      const remaining = maxOutputBytes - outputBytes;
      const valueBytes = utf8ByteLength(value);
      if (valueBytes <= remaining) {
        pushChunk(value);
        outputBytes += valueBytes;
        return true;
      }
      const prefix = takeUtf8Prefix(value, remaining);
      pushChunk(prefix.text);
      outputBytes += prefix.bytes;
      truncated = true;
      byteTruncated = true;
      stopped = true;
      return false;
    };

    const markTruncated = (): void => {
      truncated = true;
    };

    const writeJsonString = (value: string): void => {
      if (!append('"')) return;
      const hexadecimal = "0123456789abcdef";
      let buffer = "";
      const flush = (): boolean => {
        if (!buffer) return true;
        const current = buffer;
        buffer = "";
        return append(current);
      };

      for (let index = 0; index < value.length && !stopped; index += 1) {
        const character = value[index];
        if (character === '"') {
          buffer += '\\"';
        } else if (character === "\\") {
          buffer += "\\\\";
        } else if (character === "\b") {
          buffer += "\\b";
        } else if (character === "\f") {
          buffer += "\\f";
        } else if (character === "\n") {
          buffer += "\\n";
        } else if (character === "\r") {
          buffer += "\\r";
        } else if (character === "\t") {
          buffer += "\\t";
        } else {
          const controlIndex = manualCharacterIndex(
            controlCharacters,
            character,
          );
          if (controlIndex >= 0) {
            buffer += `\\u00${hexadecimal[(controlIndex >> 4) & 0xf]}${
              hexadecimal[controlIndex & 0xf]
            }`;
          } else {
            buffer += character;
          }
        }
        if (buffer.length >= 512 && !flush()) return;
      }
      if (!flush()) return;
      append('"');
    };

    const writeString = (value: string, root: boolean): void => {
      const sanitized = sanitizeBoundedText(value, MAX_STRING_LENGTH);
      redacted = redacted || sanitized.redacted;
      if (sanitized.truncated) markTruncated();
      if (root) {
        append(sanitized.text);
      } else {
        writeJsonString(sanitized.text);
      }
    };

    const writeFixedString = (value: string, root: boolean): void => {
      if (root) append(value);
      else writeJsonString(value);
    };

    const wasSeen = (value: object, depth: number): boolean => {
      const activeDepth = MAX_DEPTH - depth;
      for (
        let index = 0;
        index < activeDepth && index < seen.length;
        index += 1
      ) {
        if (seen[index] === value) return true;
      }
      // Slots at this depth or below belong to a completed sibling branch.
      seen.length = activeDepth;
      seen[activeDepth] = value;
      return false;
    };

    const readObjectTag = (value: object): string => {
      try {
        const tag = Object.prototype.toString.call(value);
        return typeof tag === "string" && tag.length <= 64 ? tag : "";
      } catch {
        return "";
      }
    };

    const writeSpecialObject = (
      value: Record<string, unknown>,
      tag: string,
      root: boolean,
    ): boolean => {
      if (tag === "[object Date]") {
        let iso = "";
        try {
          const toISOString = value.toISOString;
          const candidate =
            typeof toISOString === "function"
              ? toISOString.call(value)
              : undefined;
          if (typeof candidate === "string") iso = candidate;
        } catch {
          // Preserve the type hint without trusting a page-provided method.
        }
        const sanitized = sanitizeBoundedText(iso, 128);
        redacted = redacted || sanitized.redacted;
        if (sanitized.truncated) markTruncated();
        writeFixedString(
          sanitized.text ? `[Date: ${sanitized.text}]` : "[Date]",
          root,
        );
        return true;
      }

      if (tag === "[object RegExp]") {
        let source = "";
        let flags = "";
        try {
          if (typeof value.source === "string") source = value.source;
          if (typeof value.flags === "string") flags = value.flags;
        } catch {
          // Preserve the type hint without trusting page-provided accessors.
        }
        const sanitizedSource = sanitizeBoundedText(source, 256);
        const sanitizedFlags = sanitizeBoundedText(flags, 32);
        redacted =
          redacted || sanitizedSource.redacted || sanitizedFlags.redacted;
        if (sanitizedSource.truncated || sanitizedFlags.truncated) {
          markTruncated();
        }
        writeFixedString(
          sanitizedSource.text
            ? `[RegExp: /${sanitizedSource.text}/${sanitizedFlags.text}]`
            : "[RegExp]",
          root,
        );
        return true;
      }

      if (tag === "[object Map]" || tag === "[object Set]") {
        const type = tag === "[object Map]" ? "Map" : "Set";
        let size: number | null = null;
        try {
          const candidate = value.size;
          if (
            typeof candidate === "number" &&
            candidate >= 0 &&
            candidate <= 9_007_199_254_740_991 &&
            candidate % 1 === 0
          ) {
            size = candidate;
          }
        } catch {
          // Preserve the type hint without trusting page-provided accessors.
        }
        writeFixedString(
          size === null ? `[${type}]` : `[${type}(${size})]`,
          root,
        );
        return true;
      }

      return false;
    };

    const writeValue = (
      value: unknown,
      depth: number,
      context: "root" | "array" | "object",
    ): void => {
      if (stopped) return;
      const root = context === "root";
      if (depth < 0) {
        markTruncated();
        writeFixedString("[MaxDepth]", root);
        return;
      }
      visitedValues += 1;
      if (visitedValues > MAX_VISITED_VALUES) {
        markTruncated();
        writeFixedString("[NodeLimit]", root);
        nodeLimitReached = true;
        return;
      }

      if (typeof value === "string") {
        writeString(value, root);
        return;
      }
      if (value === null) {
        append("null");
        return;
      }
      if (typeof value === "undefined") {
        append(root ? "undefined" : "null");
        return;
      }
      if (typeof value === "boolean") {
        append(value ? "true" : "false");
        return;
      }
      if (typeof value === "number") {
        append(
          value === value && value !== Infinity && value !== -Infinity
            ? `${value}`
            : "null",
        );
        return;
      }
      if (typeof value === "bigint") {
        if (
          value >= MAX_SERIALIZABLE_BIGINT ||
          value <= -MAX_SERIALIZABLE_BIGINT
        ) {
          markTruncated();
          writeJsonString("[BigInt exceeds serialization limit]");
        } else {
          // BigInts are converted by the legacy sanitizer into a JSON string.
          writeJsonString(`${value}n`);
        }
        return;
      }
      if (typeof value === "symbol") {
        let description = "";
        try {
          description =
            typeof value.description === "string" ? value.description : "";
        } catch {
          // Keep the description empty.
        }
        const sanitized = sanitizeBoundedText(
          description,
          MAX_STRING_LENGTH - 8,
        );
        redacted = redacted || sanitized.redacted;
        if (sanitized.truncated) markTruncated();
        writeFixedString(`Symbol(${sanitized.text})`, root);
        return;
      }
      if (typeof value === "function") {
        let name = "";
        try {
          name = typeof value.name === "string" ? value.name : "";
        } catch {
          // Proxied functions may throw while reading name.
        }
        const sanitized = sanitizeBoundedText(name, MAX_STRING_LENGTH - 16);
        redacted = redacted || sanitized.redacted;
        if (sanitized.truncated) markTruncated();
        writeFixedString(
          sanitized.text ? `[Function: ${sanitized.text}]` : "[Function]",
          root,
        );
        return;
      }
      if (typeof value !== "object") {
        writeFixedString("[Unsupported value]", root);
        return;
      }

      const objectValue = value as Record<string, unknown>;
      if (wasSeen(objectValue, depth)) {
        writeFixedString("[Circular]", root);
        return;
      }

      const objectTag = readObjectTag(objectValue);
      if (writeSpecialObject(objectValue, objectTag, root)) return;

      let arrayValue = false;
      try {
        arrayValue = Array.isArray(objectValue) === true;
      } catch {
        markTruncated();
      }

      if (arrayValue) {
        if (!append("[")) return;
        let length = 0;
        let lengthFailed = false;
        try {
          const candidate = (objectValue as unknown as unknown[]).length;
          length =
            typeof candidate === "number" && candidate > 0
              ? candidate > MAX_ARRAY_LENGTH
                ? MAX_ARRAY_LENGTH + 1
                : candidate
              : 0;
        } catch {
          lengthFailed = true;
          markTruncated();
        }
        const count = length > MAX_ARRAY_LENGTH ? MAX_ARRAY_LENGTH : length;
        for (
          let index = 0;
          index < count && !stopped && !nodeLimitReached;
          index += 1
        ) {
          if (index > 0 && !append(",")) break;
          let item: unknown;
          try {
            item = objectValue[index];
          } catch {
            markTruncated();
            item = "[Property access threw]";
          }
          writeValue(item, depth - 1, "array");
        }
        if (!stopped && (length > MAX_ARRAY_LENGTH || lengthFailed)) {
          if (count > 0) append(",");
          markTruncated();
          writeJsonString(
            lengthFailed ? "[Length access threw]" : "[...truncated]",
          );
        }
        append("]");
        return;
      }

      if (!append("{")) return;
      let emitted = 0;
      let inspected = 0;
      let hasMoreKeys = false;
      let enumerationFailed = false;
      try {
        for (const rawKey in objectValue) {
          if (nodeLimitReached) break;
          let isOwn = false;
          try {
            isOwn =
              Object.prototype.hasOwnProperty.call(objectValue, rawKey) ===
              true;
          } catch {
            enumerationFailed = true;
            break;
          }
          if (!isOwn) continue;
          if (inspected >= MAX_OBJECT_KEYS) {
            hasMoreKeys = true;
            break;
          }
          inspected += 1;

          const longKey = rawKey.length > MAX_KEY_LENGTH;
          const sensitiveKey = longKey || isSensitiveKey(rawKey);
          const keyResult = sanitizeBoundedText(rawKey, MAX_KEY_LENGTH);
          redacted = redacted || keyResult.redacted;
          if (keyResult.truncated) markTruncated();
          if (sensitiveKey) {
            if (emitted > 0 && !append(",")) break;
            writeJsonString(keyResult.text);
            if (!append(":")) break;
            redacted = true;
            writeJsonString("<redacted>");
            emitted += 1;
            continue;
          }

          let propertyValue: unknown;
          let accessFailed = false;
          try {
            propertyValue = objectValue[rawKey];
          } catch {
            propertyValue = "[Property access threw]";
            accessFailed = true;
            markTruncated();
          }
          // JSON.stringify omits undefined-valued object properties. Match that
          // behavior after counting the key against the traversal ceiling.
          if (typeof propertyValue === "undefined") continue;

          if (emitted > 0 && !append(",")) break;
          writeJsonString(keyResult.text);
          if (!append(":")) break;
          if (accessFailed) {
            writeJsonString("[Property access threw]");
          } else {
            writeValue(propertyValue, depth - 1, "object");
          }
          emitted += 1;
        }
      } catch {
        enumerationFailed = true;
      }

      if (!stopped && (hasMoreKeys || enumerationFailed)) {
        if (emitted > 0) append(",");
        markTruncated();
        writeJsonString(
          enumerationFailed ? "__serialization_error__" : "__truncated__",
        );
        append(":true");
      }
      append("}");
    };

    const finishText = (): string => {
      let joined = "";
      for (let index = 0; index < chunks.length; index += 1) {
        joined += chunks[index];
      }
      if (!byteTruncated) return joined;
      const suffix = `\n... [truncated to ${maxOutputBytes} bytes]`;
      const suffixBytes = utf8ByteLength(suffix);
      if (suffixBytes >= maxOutputBytes) {
        return takeUtf8Prefix(joined, maxOutputBytes).text;
      }
      return takeUtf8Prefix(joined, maxOutputBytes - suffixBytes).text + suffix;
    };

    const serializeError = (error: unknown): PageSerializationEnvelope => {
      let name = "";
      let message = "";
      let stack = "";
      if (typeof error === "string") {
        message = error;
      } else if (
        error === null ||
        typeof error === "number" ||
        typeof error === "boolean"
      ) {
        message = `${error}`;
      } else if (typeof error === "bigint") {
        message =
          error >= MAX_SERIALIZABLE_BIGINT || error <= -MAX_SERIALIZABLE_BIGINT
            ? "[BigInt error exceeds serialization limit]"
            : `${error}`;
      } else if (typeof error === "object" || typeof error === "function") {
        try {
          name =
            typeof (error as { name?: unknown }).name === "string"
              ? ((error as { name: string }).name ?? "")
              : "";
        } catch {
          // Keep the field empty.
        }
        try {
          message =
            typeof (error as { message?: unknown }).message === "string"
              ? ((error as { message: string }).message ?? "")
              : "";
        } catch {
          // Keep the field empty.
        }
        try {
          stack =
            typeof (error as { stack?: unknown }).stack === "string"
              ? ((error as { stack: string }).stack ?? "")
              : "";
        } catch {
          // Keep the field empty.
        }
      }

      const raw = stack || message || name || "JavaScript execution failed";
      const sanitized = sanitizeBoundedText(raw, MAX_STRING_LENGTH);
      const bounded = takeUtf8Prefix(sanitized.text, maxOutputBytes);
      const errorWasTruncated =
        sanitized.truncated || bounded.text.length < sanitized.text.length;
      const suffix = errorWasTruncated ? "\n... [error truncated]" : "";
      const suffixBytes = utf8ByteLength(suffix);
      const finalMessage = errorWasTruncated
        ? suffixBytes >= maxOutputBytes
          ? bounded.text
          : takeUtf8Prefix(sanitized.text, maxOutputBytes - suffixBytes).text +
            suffix
        : bounded.text;
      const syntaxSource = `${copyRange(name, 0, 128)} ${copyRange(
        message,
        0,
        128,
      )}`;
      const safeMessage =
        finalMessage ||
        takeUtf8Prefix("JavaScript execution failed", maxOutputBytes).text;
      return {
        version: 1,
        status: "error",
        errorKind: containsText(syntaxSource, "syntaxerror", true)
          ? "syntax_error"
          : "runtime_error",
        message: safeMessage,
      };
    };

    let holderStatus: unknown;
    let holderValue: unknown;
    try {
      holderStatus = this?.__webpageMcpStatus;
      holderValue = this?.__webpageMcpValue;
    } catch {
      return {
        version: 1,
        status: "error",
        errorKind: "serialization_error",
        message: "JavaScript result holder could not be read",
      };
    }
    if (holderStatus === 0) return serializeError(holderValue);
    if (holderStatus !== 1) {
      return {
        version: 1,
        status: "error",
        errorKind: "serialization_error",
        message: "JavaScript result holder was invalid",
      };
    }

    writeValue(holderValue, MAX_DEPTH, "root");
    return {
      version: 1,
      status: "success",
      text: finishText(),
      truncated,
      redacted,
    };
  } catch {
    // Never let a hostile Proxy or a page-modified intrinsic turn into an
    // unbounded CDP exceptionDetails payload.
    return {
      version: 1,
      status: "error",
      errorKind: "serialization_error",
      message: "Bounded page serialization failed",
    };
  }
}
