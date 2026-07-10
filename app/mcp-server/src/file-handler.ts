import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

const INVALID_TEMP_FILE_NAME_CHARS = new Set(['<', '>', ':', '"', '/', '\\', '|', '?', '*']);
const MAX_CONTROL_CHARACTER_CODE = 31;

/**
 * File handler for managing file uploads through the native messaging host
 */
export class FileHandler {
  private readonly tempDir: string;
  private disposed = false;
  private readonly exitHandler = (): void => this.dispose();

  constructor(temporaryRoot = os.tmpdir()) {
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
    fs.rmSync(this.tempDir, { recursive: true, force: true });
  }

  /**
   * Handle file preparation request from the extension
   */
  async handleFileRequest(request: any): Promise<any> {
    const { action, base64Data, fileName, filePath, traceFilePath, insightName } = request;

    try {
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
          try {
            // With tsconfig moduleResolution=NodeNext, relative ESM imports need explicit .js extension
            const { analyzeTraceFile } = await import('./trace-analyzer.js');
            const res = await analyzeTraceFile(targetPath, insightName);
            return { success: true, ...res };
          } catch (e: any) {
            return { success: false, error: e?.message || String(e) };
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
      // Remove data URL prefix if present
      const base64Content = base64Data.replace(/^data:.*?;base64,/, '');

      // Convert base64 to buffer
      const buffer = Buffer.from(base64Content, 'base64');

      // Normalize the client-provided name so temp writes can never escape tempDir.
      const finalFileName = this.normalizeTempFileName(fileName) || this.generateFileName();
      const filePath = this.resolveTempFilePath(finalFileName);

      // Save to file
      fs.writeFileSync(filePath, buffer, { flag: 'wx', mode: 0o600 });

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

      if (fs.existsSync(resolvedPath)) {
        fs.unlinkSync(this.resolveSafeExistingTempFile(resolvedPath));
      }

      return {
        success: true,
        message: 'File cleaned up successfully',
      };
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

  /**
   * Clean up old temporary files (older than 1 hour)
   */
  cleanupOldFiles(): void {
    try {
      const now = Date.now();
      const oneHour = 60 * 60 * 1000;

      const files = fs.readdirSync(this.tempDir);
      for (const file of files) {
        const filePath = path.join(this.tempDir, file);
        const stats = fs.lstatSync(filePath);
        if (!stats.isSymbolicLink() && stats.isFile() && now - stats.mtimeMs > oneHour) {
          fs.unlinkSync(filePath);
          // Use stderr to avoid polluting stdout (Native Messaging protocol)
          console.error(`Cleaned up old temp file: ${file}`);
        }
      }
    } catch (error) {
      console.error('Error cleaning up old files:', error);
    }
  }
}

export default new FileHandler();
