/**
 * Attachment Service for persisting and managing image attachments.
 *
 * Handles:
 * - Saving attachments to persistent storage (not temp files)
 * - Getting attachment statistics per project
 * - Cleaning up attachments by project or all
 *
 * Storage structure:
 *   ~/.webpage-mcp-agent/attachments/{projectId}/{messageId}-{index}-{uuid}.{ext}
 */
import fs from 'node:fs/promises';
import { constants as fsConstants, type BigIntStats } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  AgentAttachment,
  AttachmentInventoryPagination,
  AttachmentMetadata,
  AttachmentProjectStats,
} from 'webpage-mcp-shared';
import {
  AGENT_ATTACHMENT_CLEANUP_MAX_RESULTS,
  AGENT_ATTACHMENT_PROJECT_SCAN_MAX_ENTRIES,
  AGENT_ATTACHMENT_STATS_MAX_OFFSET,
  AGENT_ATTACHMENT_STATS_ROOT_SCAN_MAX_ENTRIES,
} from 'webpage-mcp-shared';
import { getAgentDataDir, PRIVATE_DIRECTORY_MODE, PRIVATE_FILE_MODE } from './storage';
import {
  ALLOWED_AGENT_ATTACHMENT_MIME_TYPES,
  decodeValidatedAgentAttachment,
  MAX_PROJECT_ATTACHMENT_BYTES,
  MAX_PROJECT_ATTACHMENT_FILES,
} from './attachment-limits';
import {
  isValidAttachmentProjectId,
  normalizeAttachmentCleanupRequest,
  normalizeAttachmentStatsPageOptions,
} from './attachment-inventory-limits';

// ============================================================
// Types
// ============================================================

export interface SaveAttachmentInput {
  projectId: string;
  messageId: string;
  attachment: AgentAttachment;
  index: number;
}

export interface SavedAttachment {
  /** Absolute path on disk (for engines) */
  absolutePath: string;
  /** Persisted filename under project dir */
  filename: string;
  /** Metadata to store in message.metadata.attachments */
  metadata: AttachmentMetadata;
}

export interface AttachmentStats {
  rootDir: string;
  totalFiles: number;
  totalBytes: number;
  projects: AttachmentProjectStats[];
  inventoryTruncated: boolean;
  truncatedProjects: number;
  pagination: AttachmentInventoryPagination;
}

export interface AttachmentReadChunk {
  buffer: Buffer;
  offset: number;
  totalBytes: number;
}

export interface CleanupAttachmentsInput {
  /** If omitted, cleanup all project dirs under root */
  projectIds?: string[];
}

export interface CleanupAttachmentsOptions {
  /** Continue after per-project failures. Defaults to true only for all-project cleanup. */
  continueOnError?: boolean;
}

export interface CleanupProjectResult {
  projectId: string;
  dirPath: string;
  existed: boolean;
  removedFiles: number;
  removedBytes: number;
  countsTruncated: boolean;
  error?: string;
}

export interface CleanupResult {
  rootDir: string;
  removedFiles: number;
  removedBytes: number;
  processedProjects: number;
  failedProjects: number;
  skippedProjects: number;
  /** Projects whose removedFiles/removedBytes contributions are lower bounds. */
  countsTruncatedProjects: number;
  resultCount: number;
  resultsTruncated: boolean;
  enumerationTruncated: boolean;
  results: CleanupProjectResult[];
}

// ============================================================
// Constants
// ============================================================

const ATTACHMENTS_DIR_NAME = 'attachments';

export interface AttachmentServiceOptions {
  maxProjectBytes?: number;
  maxProjectFiles?: number;
  maxProjectScanEntries?: number;
  maxStatsRootScanEntries?: number;
  maxCleanupResults?: number;
}

// ============================================================
// Helper Functions
// ============================================================

/**
 * Convert MIME type to file extension.
 */
function mimeTypeToExt(mimeType: string): string {
  switch (mimeType) {
    case 'image/png':
      return 'png';
    case 'image/jpeg':
      return 'jpg';
    case 'image/gif':
      return 'gif';
    case 'image/webp':
      return 'webp';
    default:
      return 'bin';
  }
}

/**
 * Build a unique filename for an attachment.
 * Format: {messageId}-{index}-{uuid}.{ext}
 */
function buildAttachmentFilename(params: {
  messageId: string;
  index: number;
  mimeType: string;
}): string {
  const ext = mimeTypeToExt(params.mimeType);
  const uuid = randomUUID().slice(0, 8);
  return `${params.messageId}-${params.index}-${uuid}.${ext}`;
}

/**
 * Validate filename to prevent path traversal attacks.
 */
function isValidFilename(filename: string): boolean {
  // Reject empty, path separators, parent directory references
  if (!filename || filename.includes('/') || filename.includes('\\')) {
    return false;
  }
  if (filename === '.' || filename === '..' || filename.startsWith('.')) {
    return false;
  }
  // Only allow alphanumeric, dash, underscore, dot
  return /^[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+$/.test(filename);
}

/**
 * Validate projectId to prevent path traversal attacks.
 */
function isValidProjectId(projectId: string): boolean {
  return isValidAttachmentProjectId(projectId);
}

function saturatingAdd(current: number, addition: number): number {
  if (!Number.isSafeInteger(addition) || addition < 0) return Number.MAX_SAFE_INTEGER;
  return addition > Number.MAX_SAFE_INTEGER - current
    ? Number.MAX_SAFE_INTEGER
    : current + addition;
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.birthtimeNs === right.birthtimeNs
  );
}

// ============================================================
// AttachmentService Class
// ============================================================

export class AttachmentService {
  private readonly maxProjectBytes: number;
  private readonly maxProjectFiles: number;
  private readonly maxProjectScanEntries: number;
  private readonly maxStatsRootScanEntries: number;
  private readonly maxCleanupResults: number;
  private readonly projectWriteTails = new Map<string, Promise<void>>();

  constructor(options: AttachmentServiceOptions = {}) {
    this.maxProjectBytes = options.maxProjectBytes ?? MAX_PROJECT_ATTACHMENT_BYTES;
    this.maxProjectFiles = options.maxProjectFiles ?? MAX_PROJECT_ATTACHMENT_FILES;
    this.maxProjectScanEntries =
      options.maxProjectScanEntries ?? AGENT_ATTACHMENT_PROJECT_SCAN_MAX_ENTRIES;
    this.maxStatsRootScanEntries =
      options.maxStatsRootScanEntries ?? AGENT_ATTACHMENT_STATS_ROOT_SCAN_MAX_ENTRIES;
    this.maxCleanupResults =
      options.maxCleanupResults ?? AGENT_ATTACHMENT_CLEANUP_MAX_RESULTS;
    if (!Number.isSafeInteger(this.maxProjectBytes) || this.maxProjectBytes <= 0) {
      throw new RangeError('maxProjectBytes must be a positive safe integer');
    }
    if (!Number.isSafeInteger(this.maxProjectFiles) || this.maxProjectFiles <= 0) {
      throw new RangeError('maxProjectFiles must be a positive safe integer');
    }
    if (
      !Number.isSafeInteger(this.maxProjectScanEntries) ||
      this.maxProjectScanEntries <= 0 ||
      this.maxProjectScanEntries > AGENT_ATTACHMENT_PROJECT_SCAN_MAX_ENTRIES
    ) {
      throw new RangeError(
        `maxProjectScanEntries must be between 1 and ${AGENT_ATTACHMENT_PROJECT_SCAN_MAX_ENTRIES}`,
      );
    }
    if (
      !Number.isSafeInteger(this.maxStatsRootScanEntries) ||
      this.maxStatsRootScanEntries <= 0 ||
      this.maxStatsRootScanEntries > AGENT_ATTACHMENT_STATS_ROOT_SCAN_MAX_ENTRIES
    ) {
      throw new RangeError(
        `maxStatsRootScanEntries must be between 1 and ${AGENT_ATTACHMENT_STATS_ROOT_SCAN_MAX_ENTRIES}`,
      );
    }
    if (
      !Number.isSafeInteger(this.maxCleanupResults) ||
      this.maxCleanupResults <= 0 ||
      this.maxCleanupResults > AGENT_ATTACHMENT_CLEANUP_MAX_RESULTS
    ) {
      throw new RangeError(
        `maxCleanupResults must be between 1 and ${AGENT_ATTACHMENT_CLEANUP_MAX_RESULTS}`,
      );
    }
  }

  /**
   * Get the root directory for all attachments.
   */
  getAttachmentsRootDir(): string {
    return path.join(getAgentDataDir(), ATTACHMENTS_DIR_NAME);
  }

  /**
   * Get the directory for a specific project's attachments.
   */
  getProjectAttachmentsDir(projectId: string): string {
    if (!isValidProjectId(projectId)) {
      throw new Error(`Invalid projectId: ${projectId}`);
    }
    return path.join(this.getAttachmentsRootDir(), projectId);
  }

  /**
   * Get the absolute path for a specific attachment file.
   * Validates to prevent path traversal attacks.
   */
  getAttachmentPath(projectId: string, filename: string): string {
    if (!isValidProjectId(projectId)) {
      throw new Error(`Invalid projectId: ${projectId}`);
    }
    if (!isValidFilename(filename)) {
      throw new Error(`Invalid filename: ${filename}`);
    }

    const projectDir = this.getProjectAttachmentsDir(projectId);
    const filePath = path.join(projectDir, filename);

    // Double-check resolved path is a direct descendant (defense in depth).
    const resolved = path.resolve(filePath);
    const resolvedProjectDir = path.resolve(projectDir);
    const relative = path.relative(resolvedProjectDir, resolved);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('Path traversal attempt detected');
    }

    return filePath;
  }

  /**
   * Save an attachment to persistent storage.
   * Creates directories if needed.
   */
  async saveAttachment(input: SaveAttachmentInput): Promise<SavedAttachment> {
    const { projectId, messageId, attachment, index } = input;

    // Validate input
    if (!isValidProjectId(projectId)) {
      throw new Error(`Invalid projectId: ${projectId}`);
    }
    if (attachment.type !== 'image') {
      throw new Error(`Unsupported attachment type: ${attachment.type}`);
    }
    if (!ALLOWED_AGENT_ATTACHMENT_MIME_TYPES.has(attachment.mimeType)) {
      throw new Error(`Unsupported MIME type: ${attachment.mimeType}`);
    }

    // Build filename and paths
    const filename = buildAttachmentFilename({
      messageId,
      index,
      mimeType: attachment.mimeType,
    });
    const projectDir = this.getProjectAttachmentsDir(projectId);
    const absolutePath = path.join(projectDir, filename);

    // Decode base64 and get size
    const buffer = decodeValidatedAgentAttachment(attachment);
    const sizeBytes = buffer.length;

    await this.withProjectWriteLock(projectId, async () => {
      // Create directory and enforce the persistent per-project quota atomically.
      await fs.mkdir(projectDir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
      await this.assertSafeProjectDirectory(projectDir);
      if (process.platform !== 'win32') {
        await Promise.all([
          fs.chmod(this.getAttachmentsRootDir(), PRIVATE_DIRECTORY_MODE),
          fs.chmod(projectDir, PRIVATE_DIRECTORY_MODE),
        ]);
      }
      const projectStats = await this.getProjectStats(projectId, projectDir);
      if (projectStats.inventoryTruncated) {
        throw new Error('Project attachment inventory exceeds the safe scan limit');
      }
      if (projectStats.fileCount >= this.maxProjectFiles) {
        throw new Error(`Project attachment file limit (${this.maxProjectFiles}) reached`);
      }
      if (projectStats.totalBytes + sizeBytes > this.maxProjectBytes) {
        throw new Error(`Project attachment byte limit (${this.maxProjectBytes}) exceeded`);
      }
      await fs.writeFile(absolutePath, buffer, {
        flag: 'wx',
        mode: PRIVATE_FILE_MODE,
      });
    });

    // Build metadata
    const metadata: AttachmentMetadata = {
      version: 1,
      kind: 'image',
      projectId,
      messageId,
      index,
      filename,
      urlPath: `/agent/attachments/${projectId}/${filename}`,
      mimeType: attachment.mimeType,
      sizeBytes,
      originalName: attachment.name,
      createdAt: new Date().toISOString(),
    };

    console.error(`[AttachmentService] Saved attachment: ${absolutePath} (${sizeBytes} bytes)`);

    return {
      absolutePath,
      filename,
      metadata,
    };
  }

  /** Delete one previously saved attachment, used to roll back failed batches. */
  async deleteAttachment(projectId: string, filename: string): Promise<void> {
    await this.withProjectWriteLock(projectId, async () => {
      const filePath = this.getAttachmentPath(projectId, filename);
      await fs.rm(filePath, { force: true });
      const projectDir = this.getProjectAttachmentsDir(projectId);
      let directory: Awaited<ReturnType<typeof fs.opendir>> | undefined;
      try {
        directory = await fs.opendir(projectDir);
        if ((await directory.read()) === null) {
          await directory.close();
          directory = undefined;
          await fs.rmdir(projectDir);
        }
      } catch {
        // The directory is non-empty, already gone, or concurrently unavailable.
      } finally {
        await directory?.close().catch(() => undefined);
      }
    });
  }

  private async withProjectWriteLock<T>(projectId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.projectWriteTails.get(projectId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.projectWriteTails.set(projectId, tail);
    await previous;
    try {
      return await task();
    } finally {
      release();
      if (this.projectWriteTails.get(projectId) === tail) {
        this.projectWriteTails.delete(projectId);
      }
    }
  }

  /**
   * Get statistics for all attachments.
   */
  async getAttachmentStats(
    options: { limit?: number; offset?: number } = {},
  ): Promise<AttachmentStats> {
    const page = normalizeAttachmentStatsPageOptions(options);
    const rootDir = this.getAttachmentsRootDir();
    const projects: AttachmentProjectStats[] = [];
    let totalFiles = 0;
    let totalBytes = 0;
    let truncatedProjects = 0;
    let scannedEntries = 0;
    let entryIndex = 0;
    let hasMore = false;
    let nextOffset: number | null = null;
    let scanTruncated = false;

    try {
      const directory = await fs.opendir(rootDir);
      for await (const entry of directory) {
        const currentIndex = entryIndex;
        entryIndex += 1;
        if (currentIndex < page.offset) continue;
        if (
          projects.length >= page.limit ||
          scannedEntries >= this.maxStatsRootScanEntries
        ) {
          if (currentIndex <= AGENT_ATTACHMENT_STATS_MAX_OFFSET) {
            hasMore = true;
            nextOffset = currentIndex;
          } else {
            // Never advertise a cursor that the request validator will reject.
            scanTruncated = true;
          }
          scanTruncated ||= scannedEntries >= this.maxStatsRootScanEntries;
          break;
        }
        scannedEntries += 1;
        if (!entry.isDirectory() || !isValidProjectId(entry.name)) continue;
        const projectId = entry.name;
        const dirPath = path.join(rootDir, projectId);
        try {
          const stats = await this.getProjectStats(projectId, dirPath);
          projects.push(stats);
          totalFiles = saturatingAdd(totalFiles, stats.fileCount);
          totalBytes = saturatingAdd(totalBytes, stats.totalBytes);
          if (stats.inventoryTruncated) truncatedProjects += 1;
        } catch (error) {
          scanTruncated = true;
          console.error(`[AttachmentService] Failed to stat project ${projectId}:`, error);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        scanTruncated = true;
      }
    }

    const pagination: AttachmentInventoryPagination = {
      limit: page.limit,
      offset: page.offset,
      count: projects.length,
      hasMore,
      nextOffset,
      scannedEntries,
      scanTruncated,
    };
    return {
      rootDir,
      totalFiles,
      totalBytes,
      projects,
      inventoryTruncated: hasMore || scanTruncated || truncatedProjects > 0,
      truncatedProjects,
      pagination,
    };
  }

  /**
   * Get statistics for a single project.
   */
  private async getProjectStats(
    projectId: string,
    dirPath: string,
  ): Promise<AttachmentProjectStats> {
    let fileCount = 0;
    let totalBytes = 0;
    let lastModifiedAt: string | undefined;
    let latestMtime = 0;
    let scannedEntries = 0;
    let inventoryTruncated = false;

    let directory: Awaited<ReturnType<typeof fs.opendir>>;
    try {
      directory = await fs.opendir(dirPath);
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException)?.code === 'ENOENT';
      return {
        projectId,
        dirPath,
        exists: !missing,
        fileCount: 0,
        totalBytes: 0,
        scannedEntries: 0,
        inventoryTruncated: !missing,
      };
    }

    try {
      for await (const entry of directory) {
        if (scannedEntries >= this.maxProjectScanEntries) {
          inventoryTruncated = true;
          break;
        }
        scannedEntries += 1;
        if (!entry.isFile()) continue;
        const filePath = path.join(dirPath, entry.name);
        try {
          const stat = await fs.stat(filePath);
          if (stat.isFile()) {
            if (!Number.isSafeInteger(stat.size) || stat.size < 0) {
              inventoryTruncated = true;
              continue;
            }
            fileCount++;
            totalBytes = saturatingAdd(totalBytes, stat.size);
            if (stat.mtimeMs > latestMtime) {
              latestMtime = stat.mtimeMs;
              lastModifiedAt = stat.mtime.toISOString();
            }
          }
        } catch {
          inventoryTruncated = true;
        }
      }
    } catch {
      inventoryTruncated = true;
    }

    return {
      projectId,
      dirPath,
      exists: true,
      fileCount,
      totalBytes,
      scannedEntries,
      inventoryTruncated,
      lastModifiedAt,
    };
  }

  /**
   * Cleanup attachments for specified projects or all projects.
   */
  async cleanupAttachments(
    input?: CleanupAttachmentsInput,
    options: CleanupAttachmentsOptions = {},
  ): Promise<CleanupResult> {
    const normalized = normalizeAttachmentCleanupRequest(input);
    const rootDir = this.getAttachmentsRootDir();
    const results: CleanupProjectResult[] = [];
    let totalRemovedFiles = 0;
    let totalRemovedBytes = 0;
    let processedProjects = 0;
    let failedProjects = 0;
    let skippedProjects = 0;
    let countsTruncatedProjects = 0;
    let resultsTruncated = false;
    const enumerationState = { truncated: false };
    const continueOnError = options.continueOnError ?? !normalized.selected;
    const projectIds: AsyncIterable<string> | Iterable<string> = normalized.selected
      ? (normalized.projectIds ?? [])
      : this.iterateAttachmentProjectIds(rootDir, enumerationState);

    for await (const projectId of projectIds) {
      if (!isValidProjectId(projectId)) {
        skippedProjects = saturatingAdd(skippedProjects, 1);
        continue;
      }
      processedProjects = saturatingAdd(processedProjects, 1);
      try {
        const result = await this.withProjectWriteLock(projectId, () =>
          this.cleanupProject(projectId),
        );
        totalRemovedFiles = saturatingAdd(totalRemovedFiles, result.removedFiles);
        totalRemovedBytes = saturatingAdd(totalRemovedBytes, result.removedBytes);
        if (result.countsTruncated) {
          countsTruncatedProjects = saturatingAdd(countsTruncatedProjects, 1);
        }
        if (results.length < this.maxCleanupResults) results.push(result);
        else resultsTruncated = true;
      } catch (error) {
        if (!continueOnError) throw error;
        failedProjects = saturatingAdd(failedProjects, 1);
        const failedResult: CleanupProjectResult = {
          projectId,
          dirPath: this.getProjectAttachmentsDir(projectId),
          existed: true,
          removedFiles: 0,
          removedBytes: 0,
          countsTruncated: false,
          error: 'Failed to clean attachment directory',
        };
        if (results.length < this.maxCleanupResults) results.push(failedResult);
        else resultsTruncated = true;
      }
    }

    return {
      rootDir,
      removedFiles: totalRemovedFiles,
      removedBytes: totalRemovedBytes,
      processedProjects,
      failedProjects,
      skippedProjects,
      countsTruncatedProjects,
      resultCount: results.length,
      resultsTruncated,
      enumerationTruncated: enumerationState.truncated,
      results,
    };
  }

  private async *iterateAttachmentProjectIds(
    rootDir: string,
    state: { truncated: boolean },
  ): AsyncGenerator<string> {
    let directory: Awaited<ReturnType<typeof fs.opendir>>;
    try {
      directory = await fs.opendir(rootDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') state.truncated = true;
      return;
    }
    try {
      for await (const entry of directory) {
        if (entry.isDirectory()) yield entry.name;
      }
    } catch (error) {
      state.truncated = true;
      console.error('[AttachmentService] Failed while enumerating attachment projects:', error);
    }
  }

  /**
   * Cleanup attachments for a single project.
   */
  private async cleanupProject(projectId: string): Promise<CleanupProjectResult> {
    const dirPath = this.getProjectAttachmentsDir(projectId);

    try {
      await fs.stat(dirPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        return {
          projectId,
          dirPath,
          existed: false,
          removedFiles: 0,
          removedBytes: 0,
          countsTruncated: false,
        };
      }
      throw error;
    }

    try {
      // Statistics are best effort; deletion itself is authoritative.
      const stats = await this.getProjectStats(projectId, dirPath);

      // Remove directory and all contents
      await fs.rm(dirPath, { recursive: true, force: true });

      return {
        projectId,
        dirPath,
        existed: true,
        removedFiles: stats.fileCount,
        removedBytes: stats.totalBytes,
        countsTruncated: stats.inventoryTruncated,
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to cleanup attachments for project ${projectId}: ${reason}`);
    }
  }

  /**
   * Check if an attachment file exists.
   */
  async attachmentExists(projectId: string, filename: string): Promise<boolean> {
    try {
      const projectDir = this.getProjectAttachmentsDir(projectId);
      await this.assertSafeProjectDirectory(projectDir);
      const filePath = this.getAttachmentPath(projectId, filename);
      const stats = await fs.lstat(filePath);
      return stats.isFile() && !stats.isSymbolicLink();
    } catch {
      return false;
    }
  }

  /**
   * Read a bounded attachment range without loading the whole file first.
   */
  async readAttachmentChunk(
    projectId: string,
    filename: string,
    offset: number,
    maxBytes: number,
    maxTotalBytes: number,
  ): Promise<AttachmentReadChunk> {
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new RangeError('Attachment offset must be a non-negative safe integer');
    }
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new RangeError('Attachment maxBytes must be a positive safe integer');
    }
    if (!Number.isSafeInteger(maxTotalBytes) || maxTotalBytes <= 0) {
      throw new RangeError('Attachment maxTotalBytes must be a positive safe integer');
    }

    const filePath = this.getAttachmentPath(projectId, filename);
    const projectDir = this.getProjectAttachmentsDir(projectId);
    const projectStats = await this.assertSafeProjectDirectory(projectDir);
    const pathStats = await fs.lstat(filePath, { bigint: true });
    if (pathStats.isSymbolicLink()) {
      throw new Error('Attachment symbolic links are not allowed');
    }
    if (!pathStats.isFile()) {
      throw new Error('Attachment is not a regular file');
    }

    const noFollow =
      typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
    const handle = await fs.open(filePath, fsConstants.O_RDONLY | noFollow);
    try {
      const stats = await handle.stat({ bigint: true });
      if (!stats.isFile()) {
        throw new Error('Attachment is not a regular file');
      }
      if (!sameFileIdentity(pathStats, stats)) {
        throw new Error('Attachment identity changed while opening');
      }
      const currentProjectStats = await this.assertSafeProjectDirectory(projectDir);
      if (!sameFileIdentity(projectStats, currentProjectStats)) {
        throw new Error('Attachment project directory identity changed while opening');
      }
      const size = Number(stats.size);
      if (!Number.isSafeInteger(size) || size < 0) {
        throw new Error('Attachment size is invalid');
      }
      if (size > maxTotalBytes) {
        return {
          buffer: Buffer.alloc(0),
          offset,
          totalBytes: size,
        };
      }

      const bytesToRead = Math.min(maxBytes, Math.max(0, size - offset));
      const buffer = Buffer.allocUnsafe(bytesToRead);
      let bytesRead = 0;
      while (bytesRead < bytesToRead) {
        const result = await handle.read(
          buffer,
          bytesRead,
          bytesToRead - bytesRead,
          offset + bytesRead,
        );
        if (result.bytesRead === 0) {
          break;
        }
        bytesRead += result.bytesRead;
      }

      return {
        buffer: bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead),
        offset,
        totalBytes: size,
      };
    } finally {
      await handle.close();
    }
  }

  private async assertSafeProjectDirectory(projectDir: string): Promise<BigIntStats> {
    const stats = await fs.lstat(projectDir, { bigint: true });
    if (stats.isSymbolicLink()) {
      throw new Error('Attachment project directory symbolic links are not allowed');
    }
    if (!stats.isDirectory()) {
      throw new Error('Attachment project path is not a directory');
    }
    return stats;
  }
}

// ============================================================
// Singleton Export
// ============================================================

export const attachmentService = new AttachmentService();
