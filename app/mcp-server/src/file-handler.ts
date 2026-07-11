import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

const INVALID_TEMP_FILE_NAME_CHARS = new Set(['<', '>', ':', '"', '/', '\\', '|', '?', '*']);
const MAX_CONTROL_CHARACTER_CODE = 31;
export const DEFAULT_TEMP_UPLOAD_MAX_FILE_BYTES = 16 * 1024 * 1024;
export const DEFAULT_TEMP_UPLOAD_MAX_FILES = 128;
export const DEFAULT_TEMP_UPLOAD_MAX_TOTAL_BYTES = 256 * 1024 * 1024;
export const DEFAULT_TEMP_BASE64_READ_MAX_FILE_BYTES = 700 * 1024;
export const TEMP_UPLOAD_MAX_FILENAME_BYTES = 255;
export const FILE_OPERATION_ACTION_MAX_BYTES = 64;
export const FILE_OPERATION_PATH_MAX_BYTES = 4096;
export const TRACE_INSIGHT_NAME_MAX_BYTES = 256;
export const DEFAULT_TEMP_ARTIFACT_TTL_MS = 20 * 60 * 1000;
export const MAX_TEMP_ARTIFACT_TTL_MS = 60 * 60 * 1000;
const DATA_URL_PREFIX_ALLOWANCE = 4096;

export interface FileHandlerLimits {
  maxFileBytes?: number;
  maxFiles?: number;
  maxTotalBytes?: number;
  maxBase64ReadFileBytes?: number;
  artifactTtlMs?: number;
}

interface ResolvedFileHandlerLimits {
  maxFileBytes: number;
  maxFiles: number;
  maxTotalBytes: number;
  maxBase64ReadFileBytes: number;
  artifactTtlMs: number;
}

interface TempArtifactIdentity {
  dev: bigint;
  ino: bigint;
  birthtimeNs: bigint;
}

interface TempArtifact {
  identity: TempArtifactIdentity;
  size: number;
  timer?: ReturnType<typeof setTimeout>;
}

function resolvePositiveSafeInteger(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return resolved;
}

function resolveArtifactTtl(value: number | undefined): number {
  const resolved = resolvePositiveSafeInteger(
    value,
    DEFAULT_TEMP_ARTIFACT_TTL_MS,
    'artifactTtlMs',
  );
  if (resolved > MAX_TEMP_ARTIFACT_TTL_MS) {
    throw new RangeError(`artifactTtlMs must not exceed ${MAX_TEMP_ARTIFACT_TTL_MS}`);
  }
  return resolved;
}

/**
 * File handler for managing file uploads through the native messaging host
 */
export class FileHandler {
  private readonly tempDir: string;
  private readonly limits: ResolvedFileHandlerLimits;
  private tempFileCount = 0;
  private tempFileBytes = 0;
  private readonly tempArtifacts = new Map<string, TempArtifact>();
  private disposed = false;
  private readonly exitHandler = (): void => this.dispose();

  constructor(temporaryRoot = os.tmpdir(), limits: FileHandlerLimits = {}) {
    this.limits = {
      maxFileBytes: resolvePositiveSafeInteger(
        limits.maxFileBytes,
        DEFAULT_TEMP_UPLOAD_MAX_FILE_BYTES,
        'maxFileBytes',
      ),
      maxFiles: resolvePositiveSafeInteger(
        limits.maxFiles,
        DEFAULT_TEMP_UPLOAD_MAX_FILES,
        'maxFiles',
      ),
      maxTotalBytes: resolvePositiveSafeInteger(
        limits.maxTotalBytes,
        DEFAULT_TEMP_UPLOAD_MAX_TOTAL_BYTES,
        'maxTotalBytes',
      ),
      maxBase64ReadFileBytes: resolvePositiveSafeInteger(
        limits.maxBase64ReadFileBytes,
        DEFAULT_TEMP_BASE64_READ_MAX_FILE_BYTES,
        'maxBase64ReadFileBytes',
      ),
      artifactTtlMs: resolveArtifactTtl(limits.artifactTtlMs),
    };
    // A per-process unpredictable directory prevents pre-planted symlinks and
    // cross-instance file access through a shared /tmp path.
    this.tempDir = fs.mkdtempSync(path.join(temporaryRoot, 'webpage-mcp-uploads-'));
    if (process.platform !== 'win32') {
      fs.chmodSync(this.tempDir, 0o700);
    }
    process.once('exit', this.exitHandler);
  }

  getTempDir(): string {
    return this.tempDir;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    process.removeListener('exit', this.exitHandler);
    for (const artifact of this.tempArtifacts.values()) {
      if (artifact.timer) clearTimeout(artifact.timer);
    }
    fs.rmSync(this.tempDir, { recursive: true, force: true });
    this.tempFileCount = 0;
    this.tempFileBytes = 0;
    this.tempArtifacts.clear();
  }

  /**
   * Handle file preparation request from the extension
   */
  async handleFileRequest(request: any): Promise<any> {
    const { action, base64Data, fileName, filePath, traceFilePath, insightName } = request;

    try {
      if (
        typeof action !== 'string' ||
        !action ||
        Buffer.byteLength(action, 'utf8') > FILE_OPERATION_ACTION_MAX_BYTES
      ) {
        return {
          success: false,
          error: `action must be a non-empty string up to ${FILE_OPERATION_ACTION_MAX_BYTES} bytes`,
        };
      }
      for (const [name, value] of [
        ['filePath', filePath],
        ['traceFilePath', traceFilePath],
      ] as const) {
        if (
          value !== undefined &&
          (typeof value !== 'string' ||
            Buffer.byteLength(value, 'utf8') > FILE_OPERATION_PATH_MAX_BYTES)
        ) {
          return {
            success: false,
            error: `${name} must be a string up to ${FILE_OPERATION_PATH_MAX_BYTES} bytes`,
          };
        }
      }
      if (
        insightName !== undefined &&
        (typeof insightName !== 'string' ||
          Buffer.byteLength(insightName, 'utf8') > TRACE_INSIGHT_NAME_MAX_BYTES)
      ) {
        return {
          success: false,
          error: `insightName must be a string up to ${TRACE_INSIGHT_NAME_MAX_BYTES} bytes`,
        };
      }

      switch (action) {
        case 'prepareFile':
          if (base64Data) {
            return await this.saveBase64File(base64Data, fileName);
          }
          return { success: false, error: 'base64Data is required' };

        case 'readBase64File': {
          if (!filePath) return { success: false, error: 'filePath is required' };
          return await this.readBase64File(filePath);
        }

        case 'cleanupFile':
          return await this.cleanupFile(filePath);

        case 'analyzeTrace': {
          const targetPath = traceFilePath || filePath;
          if (!targetPath) {
            return { success: false, error: 'traceFilePath is required' };
          }
          let traceFd: number | undefined;
          try {
            traceFd = this.openAnalyzableTrace(targetPath);
            // With tsconfig moduleResolution=NodeNext, relative ESM imports need explicit .js extension
            const { analyzeTraceFile } = await import('./trace-analyzer.js');
            const res = await analyzeTraceFile(traceFd, insightName);
            return { success: true, ...res };
          } catch (e: any) {
            return { success: false, error: e?.message || String(e) };
          } finally {
            if (traceFd !== undefined) fs.closeSync(traceFd);
          }
        }

        default:
          return {
            success: false,
            error: `Unknown file action: ${action}`,
          };
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Save base64 data as a file
   */
  private async saveBase64File(base64Data: string, fileName?: string): Promise<any> {
    try {
      if (typeof base64Data !== 'string') {
        throw new Error('base64Data must be a string');
      }
      const maximumEncodedCharacters =
        Math.ceil((this.limits.maxFileBytes * 4) / 3) + DATA_URL_PREFIX_ALLOWANCE;
      if (base64Data.length > maximumEncodedCharacters) {
        throw new Error(`File exceeds the ${this.limits.maxFileBytes} byte limit`);
      }

      // Remove data URL prefix if present
      const base64Content = base64Data.replace(/^data:.*?;base64,/, '');

      // Convert base64 to buffer
      const buffer = Buffer.from(base64Content, 'base64');
      if (buffer.length > this.limits.maxFileBytes) {
        throw new Error(`File exceeds the ${this.limits.maxFileBytes} byte limit`);
      }
      if (this.tempFileCount >= this.limits.maxFiles) {
        throw new Error(`Temporary upload file limit reached (${this.limits.maxFiles})`);
      }
      if (this.tempFileBytes + buffer.length > this.limits.maxTotalBytes) {
        throw new Error(
          `Temporary upload storage exceeds the ${this.limits.maxTotalBytes} byte limit`,
        );
      }

      // Normalize the client-provided name so temp writes can never escape tempDir.
      const finalFileName = this.normalizeTempFileName(fileName) || this.generateFileName();
      const filePath = this.resolveTempFilePath(finalFileName);

      const fileDescriptor = fs.openSync(
        filePath,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
        0o600,
      );
      let stats: fs.BigIntStats;
      let completed = false;
      try {
        fs.writeFileSync(fileDescriptor, buffer);
        stats = fs.fstatSync(fileDescriptor, { bigint: true });
        completed = true;
      } finally {
        try {
          fs.closeSync(fileDescriptor);
        } finally {
          if (!completed) {
            try {
              fs.unlinkSync(filePath);
            } catch {
              // Best-effort rollback for a failed create.
            }
          }
        }
      }

      this.tempFileCount += 1;
      this.tempFileBytes += buffer.length;
      const artifact: TempArtifact = {
        identity: this.identityFromStats(stats),
        size: buffer.length,
      };
      this.tempArtifacts.set(filePath, artifact);
      artifact.timer = setTimeout(
        () => this.expireArtifact(filePath, artifact),
        this.limits.artifactTtlMs,
      );
      if (typeof artifact.timer === 'object' && 'unref' in artifact.timer) {
        artifact.timer.unref();
      }

      return {
        success: true,
        filePath: filePath,
        fileName: finalFileName,
        size: buffer.length,
      };
    } catch (error) {
      throw new Error(`Failed to save base64 file: ${error}`);
    }
  }

  /**
   * Read file content and return as base64 string
   */
  private async readBase64File(filePath: string): Promise<any> {
    try {
      const resolvedPath = this.resolveExistingTempFilePath(filePath);
      if (!resolvedPath) {
        throw new Error('Can only read files in temp directory');
      }
      if (!fs.existsSync(resolvedPath)) {
        throw new Error(`File does not exist: ${resolvedPath}`);
      }
      const safePath = this.resolveSafeExistingTempFile(resolvedPath);
      const stats = fs.statSync(safePath);
      if (stats.size > this.limits.maxBase64ReadFileBytes) {
        throw new Error(
          `File exceeds the ${this.limits.maxBase64ReadFileBytes} byte base64 response limit`,
        );
      }
      const buf = fs.readFileSync(safePath);
      const base64 = buf.toString('base64');
      return {
        success: true,
        filePath: safePath,
        fileName: path.basename(safePath),
        size: stats.size,
        base64Data: base64,
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to read file: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * Clean up a temporary file
   */
  private async cleanupFile(filePath: string): Promise<any> {
    try {
      const resolvedPath = this.resolveExistingTempFilePath(filePath);
      if (!resolvedPath) {
        return {
          success: false,
          error: 'Can only cleanup files in temp directory',
        };
      }

      const artifact = this.tempArtifacts.get(resolvedPath);
      if (!artifact) {
        if (fs.existsSync(resolvedPath)) {
          return {
            success: false,
            error: 'Can only cleanup files created by this handler',
          };
        }
        return {
          success: true,
          message: 'File cleaned up successfully',
        };
      }

      try {
        if (fs.existsSync(resolvedPath)) {
          const stats = fs.lstatSync(resolvedPath, { bigint: true });
          if (!stats.isFile() || !this.identitiesMatch(artifact.identity, stats)) {
            throw new Error('Refusing to cleanup a replaced temporary artifact');
          }
          fs.unlinkSync(resolvedPath);
        }
        return {
          success: true,
          message: 'File cleaned up successfully',
        };
      } finally {
        // Missing and replaced paths must not retain authorization or quota.
        this.forgetArtifact(resolvedPath, artifact);
      }
    } catch (error) {
      return {
        success: false,
        error: `Failed to cleanup file: ${error}`,
      };
    }
  }

  /**
   * Generate a unique filename.
   */
  private generateFileName(): string {
    return `upload-${crypto.randomBytes(8).toString('hex')}.bin`;
  }

  private normalizeTempFileName(fileName?: string): string | null {
    if (typeof fileName !== 'string') {
      return null;
    }

    if (Buffer.byteLength(fileName, 'utf8') > TEMP_UPLOAD_MAX_FILENAME_BYTES) {
      throw new Error(`fileName exceeds the ${TEMP_UPLOAD_MAX_FILENAME_BYTES} byte limit`);
    }

    const trimmed = fileName.trim();
    if (!trimmed) {
      return null;
    }

    const baseName = this.sanitizeTempFileBaseName(path.basename(trimmed)).trim();
    if (!baseName || baseName === '.' || baseName === '..') {
      return null;
    }

    return baseName;
  }

  private sanitizeTempFileBaseName(fileName: string): string {
    let sanitized = '';

    for (const char of fileName) {
      const charCode = char.charCodeAt(0);
      sanitized +=
        charCode <= MAX_CONTROL_CHARACTER_CODE || INVALID_TEMP_FILE_NAME_CHARS.has(char)
          ? '_'
          : char;
    }

    return sanitized;
  }

  private resolveTempFilePath(fileName: string): string {
    return path.resolve(this.tempDir, fileName);
  }

  private resolveExistingTempFilePath(filePath: string): string | null {
    if (typeof filePath !== 'string' || !filePath.trim()) {
      return null;
    }

    const resolvedTempDir = path.resolve(this.tempDir);
    const resolvedFilePath = path.resolve(filePath);
    const relative = path.relative(resolvedTempDir, resolvedFilePath);

    if (!relative || relative === '.') {
      return null;
    }

    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      return null;
    }

    return resolvedFilePath;
  }

  private resolveSafeExistingTempFile(filePath: string): string {
    const stats = fs.lstatSync(filePath);
    if (stats.isSymbolicLink()) {
      throw new Error('Symbolic links are not allowed in the temp directory');
    }
    if (!stats.isFile()) {
      throw new Error(`Path is not a file: ${filePath}`);
    }

    const realTempDir = fs.realpathSync(this.tempDir);
    const realFilePath = fs.realpathSync(filePath);
    const relative = path.relative(realTempDir, realFilePath);
    if (!relative || relative === '.' || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('Resolved file escapes the temp directory');
    }
    return realFilePath;
  }

  private openAnalyzableTrace(filePath: string): number {
    const resolvedPath = this.resolveExistingTempFilePath(filePath);
    if (!resolvedPath) {
      throw new Error('Can only analyze trace files in the private temp directory');
    }
    const lstat = fs.lstatSync(resolvedPath);
    if (lstat.isSymbolicLink()) {
      throw new Error('Symbolic links are not allowed in the temp directory');
    }
    if (!lstat.isFile()) {
      throw new Error(`Path is not a file: ${resolvedPath}`);
    }

    const artifact = this.tempArtifacts.get(resolvedPath);
    if (!artifact) {
      throw new Error('Can only analyze trace files created by this handler');
    }

    const noFollow =
      typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
    const fileDescriptor = fs.openSync(resolvedPath, fs.constants.O_RDONLY | noFollow);
    try {
      const stats = fs.fstatSync(fileDescriptor, { bigint: true });
      if (!stats.isFile()) {
        throw new Error('Trace artifact is not a regular file');
      }
      if (!this.identitiesMatch(artifact.identity, stats)) {
        throw new Error('Trace artifact identity changed after creation');
      }
      return fileDescriptor;
    } catch (error) {
      fs.closeSync(fileDescriptor);
      throw error;
    }
  }

  private identityFromStats(stats: fs.BigIntStats): TempArtifactIdentity {
    return {
      dev: stats.dev,
      ino: stats.ino,
      birthtimeNs: stats.birthtimeNs,
    };
  }

  private identitiesMatch(identity: TempArtifactIdentity, stats: fs.BigIntStats): boolean {
    return (
      identity.dev === stats.dev &&
      identity.ino === stats.ino &&
      identity.birthtimeNs === stats.birthtimeNs
    );
  }

  private forgetArtifact(filePath: string, artifact: TempArtifact): void {
    if (this.tempArtifacts.get(filePath) !== artifact) return;
    this.tempArtifacts.delete(filePath);
    if (artifact.timer) clearTimeout(artifact.timer);
    this.tempFileCount = Math.max(0, this.tempFileCount - 1);
    this.tempFileBytes = Math.max(0, this.tempFileBytes - artifact.size);
  }

  private expireArtifact(filePath: string, artifact: TempArtifact): void {
    if (this.tempArtifacts.get(filePath) !== artifact) return;
    try {
      if (fs.existsSync(filePath)) {
        const stats = fs.lstatSync(filePath, { bigint: true });
        if (stats.isFile() && this.identitiesMatch(artifact.identity, stats)) {
          fs.unlinkSync(filePath);
        }
      }
    } catch (error) {
      console.error('Failed to expire temporary artifact:', error);
    } finally {
      this.forgetArtifact(filePath, artifact);
    }
  }

  /**
   * Clean up old temporary files (older than 1 hour)
   */
  cleanupOldFiles(): void {
    try {
      const now = Date.now();
      const oneHour = 60 * 60 * 1000;

      for (const [filePath, artifact] of this.tempArtifacts) {
        let shouldExpire = !fs.existsSync(filePath);
        if (!shouldExpire) {
          const stats = fs.lstatSync(filePath);
          shouldExpire = stats.isFile() && now - stats.mtimeMs > oneHour;
        }
        if (shouldExpire) {
          this.expireArtifact(filePath, artifact);
          // Use stderr to avoid polluting stdout (Native Messaging protocol)
          console.error(`Cleaned up old temp file: ${path.basename(filePath)}`);
        }
      }
    } catch (error) {
      console.error('Error cleaning up old files:', error);
    }
  }
}

export default new FileHandler();
