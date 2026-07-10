import {
  closeSync,
  constants,
  fstatSync,
  ftruncateSync,
  lstatSync,
  openSync,
  opendirSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";

export const DEFAULT_STDERR_LOG_MAX_BYTES = 8 * 1024 * 1024;
export const DEFAULT_WRAPPER_LOG_MAX_BYTES = 1024 * 1024;
export const DEFAULT_LOG_RETENTION_COUNT = 5;
export const MAX_CONFIGURED_LOG_BYTES = 64 * 1024 * 1024;
export const MAX_CONFIGURED_RETENTION_COUNT = 100;

export const NATIVE_LOG_ENV = {
  wrapperPath: "WEBPAGE_MCP_WRAPPER_LOG_PATH",
  stderrPath: "WEBPAGE_MCP_STDERR_LOG_PATH",
  wrapperMaxBytes: "WEBPAGE_MCP_WRAPPER_LOG_MAX_BYTES",
  stderrMaxBytes: "WEBPAGE_MCP_STDERR_LOG_MAX_BYTES",
  retentionCount: "WEBPAGE_MCP_LOG_RETENTION_COUNT",
} as const;

export const LOG_TRUNCATION_MARKER = Buffer.from(
  "[webpage-mcp] log truncated after reaching byte limit\n",
  "utf8",
);

interface LogCandidate {
  filePath: string;
  mtimeMs: number;
}

export interface NativeLogPolicy {
  wrapperPath: string;
  stderrPath: string;
  wrapperMaxBytes: number;
  stderrMaxBytes: number;
  retentionCount: number;
}

function writeAll(
  fileDescriptor: number,
  bytes: Uint8Array,
  position: number,
): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = writeSync(
      fileDescriptor,
      bytes,
      offset,
      bytes.byteLength - offset,
      position + offset,
    );
    if (written === 0) {
      throw new Error("Unable to make progress writing the native host log");
    }
    offset += written;
  }
}

function assertValidMaximum(maximumBytes: number): void {
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < LOG_TRUNCATION_MARKER.length
  ) {
    throw new RangeError(
      `Log byte limit must be an integer of at least ${LOG_TRUNCATION_MARKER.length}`,
    );
  }
}

/**
 * A synchronous writer is intentional here: stderr must be drained without
 * buffering an unbounded amount in the supervisor process.
 */
export class BoundedLogFile {
  private readonly fileDescriptor: number;
  private bytesWritten = 0;
  private closed = false;
  private truncated = false;

  constructor(
    filePath: string,
    private readonly maximumBytes: number,
  ) {
    assertValidMaximum(maximumBytes);
    this.fileDescriptor = openSync(
      filePath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC,
      0o600,
    );
  }

  write(value: string | Uint8Array): void {
    if (this.closed) {
      throw new Error("Cannot write to a closed native host log");
    }
    if (this.truncated) {
      return;
    }

    const bytes =
      typeof value === "string" ? Buffer.from(value, "utf8") : value;
    const availableBytes = this.maximumBytes - this.bytesWritten;
    if (bytes.byteLength <= availableBytes) {
      writeAll(this.fileDescriptor, bytes, this.bytesWritten);
      this.bytesWritten += bytes.byteLength;
      return;
    }

    if (availableBytes > 0) {
      writeAll(
        this.fileDescriptor,
        bytes.subarray(0, availableBytes),
        this.bytesWritten,
      );
    }
    writeAll(
      this.fileDescriptor,
      LOG_TRUNCATION_MARKER,
      this.maximumBytes - LOG_TRUNCATION_MARKER.length,
    );
    ftruncateSync(this.fileDescriptor, this.maximumBytes);
    this.bytesWritten = this.maximumBytes;
    this.truncated = true;
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    closeSync(this.fileDescriptor);
  }
}

export function capExistingLogFile(
  filePath: string,
  maximumBytes: number,
): void {
  assertValidMaximum(maximumBytes);
  const fileDescriptor = openSync(filePath, constants.O_RDWR);
  try {
    if (fstatSync(fileDescriptor).size <= maximumBytes) {
      return;
    }
    writeAll(
      fileDescriptor,
      LOG_TRUNCATION_MARKER,
      maximumBytes - LOG_TRUNCATION_MARKER.length,
    );
    ftruncateSync(fileDescriptor, maximumBytes);
  } finally {
    closeSync(fileDescriptor);
  }
}

function isNewer(left: LogCandidate, right: LogCandidate): boolean {
  return (
    left.mtimeMs > right.mtimeMs ||
    (left.mtimeMs === right.mtimeMs && left.filePath > right.filePath)
  );
}

function removeBestEffort(filePath: string): void {
  try {
    unlinkSync(filePath);
  } catch {
    // Logging must never prevent the native messaging host from starting.
  }
}

function pruneLogFamily(
  currentLogPath: string,
  filePrefix: string,
  retentionCount: number,
): void {
  const logDirectory = path.dirname(currentLogPath);
  const currentAbsolutePath = path.resolve(currentLogPath);
  const priorLogsToKeep = retentionCount - 1;
  const newestPriorLogs: LogCandidate[] = [];

  let directory;
  try {
    directory = opendirSync(logDirectory);
  } catch {
    return;
  }

  try {
    for (;;) {
      const entry = directory.readSync();
      if (entry === null) {
        break;
      }
      if (
        !entry.isFile() ||
        !entry.name.startsWith(filePrefix) ||
        !entry.name.endsWith(".log")
      ) {
        continue;
      }

      const filePath = path.join(logDirectory, entry.name);
      if (path.resolve(filePath) === currentAbsolutePath) {
        continue;
      }

      let candidate: LogCandidate;
      try {
        const stat = lstatSync(filePath);
        if (!stat.isFile()) {
          continue;
        }
        candidate = { filePath, mtimeMs: stat.mtimeMs };
      } catch {
        continue;
      }

      const insertionIndex = newestPriorLogs.findIndex((kept) =>
        isNewer(candidate, kept),
      );
      if (insertionIndex === -1) {
        newestPriorLogs.push(candidate);
      } else {
        newestPriorLogs.splice(insertionIndex, 0, candidate);
      }

      if (newestPriorLogs.length > priorLogsToKeep) {
        const staleLog = newestPriorLogs.pop();
        if (staleLog) {
          removeBestEffort(staleLog.filePath);
        }
      }
    }
  } finally {
    directory.closeSync();
  }
}

export function pruneNativeHostLogs(policy: NativeLogPolicy): void {
  pruneLogFamily(
    policy.wrapperPath,
    "native_host_wrapper_",
    policy.retentionCount,
  );
  pruneLogFamily(
    policy.stderrPath,
    "native_host_stderr_",
    policy.retentionCount,
  );
}

function parseBoundedInteger(
  value: string | undefined,
  fallback: number,
  maximum: number,
): number {
  if (!value || !/^\d+$/.test(value)) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? Math.min(parsed, maximum)
    : fallback;
}

export function consumeNativeLogPolicy(
  environment: NodeJS.ProcessEnv,
): NativeLogPolicy {
  const wrapperPath = environment[NATIVE_LOG_ENV.wrapperPath];
  const stderrPath = environment[NATIVE_LOG_ENV.stderrPath];
  const wrapperMaxBytes = parseBoundedInteger(
    environment[NATIVE_LOG_ENV.wrapperMaxBytes],
    DEFAULT_WRAPPER_LOG_MAX_BYTES,
    MAX_CONFIGURED_LOG_BYTES,
  );
  const stderrMaxBytes = parseBoundedInteger(
    environment[NATIVE_LOG_ENV.stderrMaxBytes],
    DEFAULT_STDERR_LOG_MAX_BYTES,
    MAX_CONFIGURED_LOG_BYTES,
  );
  const retentionCount = parseBoundedInteger(
    environment[NATIVE_LOG_ENV.retentionCount],
    DEFAULT_LOG_RETENTION_COUNT,
    MAX_CONFIGURED_RETENTION_COUNT,
  );

  for (const variableName of Object.values(NATIVE_LOG_ENV)) {
    delete environment[variableName];
  }

  if (!wrapperPath || !stderrPath) {
    throw new Error("Native host log paths were not provided by the wrapper");
  }

  return {
    wrapperPath,
    stderrPath,
    wrapperMaxBytes: Math.max(wrapperMaxBytes, LOG_TRUNCATION_MARKER.length),
    stderrMaxBytes: Math.max(stderrMaxBytes, LOG_TRUNCATION_MARKER.length),
    retentionCount,
  };
}
