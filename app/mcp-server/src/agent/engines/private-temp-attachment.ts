import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AgentAttachment } from 'webpage-mcp-shared';
import { decodeValidatedAgentAttachment } from '../attachment-limits';

const PRIVATE_TEMP_ATTACHMENT_PREFIX = 'webpage-mcp-agent-attachment-';

function extensionForMimeType(mimeType: string): string {
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
      throw new Error(`Unsupported MIME type: ${mimeType}`);
  }
}

/**
 * Persist one validated legacy attachment in an unpredictable private
 * directory. The filename never includes client-controlled text.
 */
export async function writePrivateTempAttachment(
  attachment: AgentAttachment,
): Promise<string> {
  const buffer = decodeValidatedAgentAttachment(attachment);
  const tempDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), PRIVATE_TEMP_ATTACHMENT_PREFIX),
  );

  try {
    if (process.platform !== 'win32') {
      await fs.chmod(tempDirectory, 0o700);
    }
    const filePath = path.join(
      tempDirectory,
      `${randomUUID()}.${extensionForMimeType(attachment.mimeType)}`,
    );
    await fs.writeFile(filePath, buffer, { flag: 'wx', mode: 0o600 });
    return filePath;
  } catch (error) {
    await fs.rm(tempDirectory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

/** Remove the private directory created for a legacy attachment. */
export async function removePrivateTempAttachment(filePath: string): Promise<void> {
  const tempDirectory = path.dirname(filePath);
  if (!path.basename(tempDirectory).startsWith(PRIVATE_TEMP_ATTACHMENT_PREFIX)) {
    throw new Error('Refusing to remove an unowned temporary attachment path');
  }
  await fs.rm(tempDirectory, { recursive: true, force: true });
}
