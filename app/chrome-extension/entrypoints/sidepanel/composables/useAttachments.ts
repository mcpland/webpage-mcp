/**
 * Composable for managing file attachments.
 * Handles file selection, drag-drop, paste, conversion, preview, and removal.
 */
import { ref, computed } from '@/entrypoints/shared/reactivity';
import type { AgentAttachment } from 'webpage-mcp-shared';

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_ATTACHMENTS = 10; // Maximum number of attachments

// Allowed image MIME types (exclude SVG for security)
const ALLOWED_IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
]);

/**
 * Extended attachment type with preview URL support.
 */
export interface AttachmentWithPreview extends AgentAttachment {
  /** Data URL for image preview (data:xxx;base64,...) */
  previewUrl?: string;
}

export function useAttachments() {
  const attachments = ref<AttachmentWithPreview[]>([]);
  const fileInputRef = ref<HTMLInputElement | null>(null);
  const error = ref<string | null>(null);
  const isDragOver = ref(false);

  // Computed: check if we have any image attachments
  const hasImages = computed(() => attachments.value.some((a) => a.type === 'image'));

  // Computed: check if we can add more attachments
  const canAddMore = computed(() => attachments.value.length < MAX_ATTACHMENTS);

  /**
   * Open file picker for image selection.
   */
  function openFilePicker(): void {
    fileInputRef.value?.click();
  }

  /**
   * Convert file to base64 string.
   */
  function fileToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        // Remove data:xxx;base64, prefix
        const base64 = result.split(',')[1];
        resolve(base64);
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  /**
   * Generate preview URL for image attachments.
   */
  function getPreviewUrl(attachment: AttachmentWithPreview): string {
    if (attachment.previewUrl) {
      return attachment.previewUrl;
    }
    // Generate data URL from base64
    return `data:${attachment.mimeType};base64,${attachment.dataBase64}`;
  }

  /**
   * Process files and add them as attachments.
   * This is the core method used by file input, drag-drop, and paste handlers.
   */
  async function handleFiles(files: File[]): Promise<void> {
    error.value = null;

    // Filter to only allowed image types (exclude SVG for security)
    const imageFiles = files.filter((file) => ALLOWED_IMAGE_TYPES.has(file.type));
    if (imageFiles.length === 0) {
      error.value = 'Only PNG, JPEG, GIF, and WebP images are supported.';
      return;
    }

    // Check attachment limit
    const remaining = MAX_ATTACHMENTS - attachments.value.length;
    if (remaining <= 0) {
      error.value = `Maximum ${MAX_ATTACHMENTS} attachments allowed.`;
      return;
    }

    const filesToProcess = imageFiles.slice(0, remaining);
    if (filesToProcess.length < imageFiles.length) {
      error.value = `Only ${remaining} more attachment(s) allowed. Some files were skipped.`;
    }

    for (const file of filesToProcess) {
      // Validate file size
      if (file.size > MAX_FILE_SIZE) {
        error.value = `File "${file.name}" is too large. Maximum size is 10MB.`;
        continue;
      }

      try {
        const base64 = await fileToBase64(file);
        const previewUrl = `data:${file.type};base64,${base64}`;

        attachments.value.push({
          type: 'image',
          name: file.name,
          mimeType: file.type || 'image/png',
          dataBase64: base64,
          previewUrl,
        });
      } catch (err) {
        console.error('Failed to read file:', err);
        error.value = `Failed to read file "${file.name}".`;
      }
    }
  }

  /**
   * Handle file selection from input element.
   */
  async function handleFileSelect(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const files = input.files;
    if (!files || files.length === 0) return;

    await handleFiles(Array.from(files));

    // Clear input to allow selecting the same file again
    input.value = '';
  }

  /**
   * Handle drag over event - update visual state.
   */
  function handleDragOver(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    isDragOver.value = true;
  }

  /**
   * Handle drag leave event - reset visual state.
   */
  function handleDragLeave(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    isDragOver.value = false;
  }

  /**
   * Handle drop event - process dropped files.
   */
  async function handleDrop(event: DragEvent): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    isDragOver.value = false;

    const files = event.dataTransfer?.files;
    if (!files || files.length === 0) return;

    await handleFiles(Array.from(files));
  }

  /**
   * Handle paste event - extract and process pasted images.
   */
  async function handlePaste(event: ClipboardEvent): Promise<void> {
    const items = event.clipboardData?.items;
    if (!items) return;

    const imageFiles: File[] = [];
    for (const item of items) {
      // Only allow specific image types (exclude SVG for security)
      if (ALLOWED_IMAGE_TYPES.has(item.type)) {
        const file = item.getAsFile();
        if (file) {
          // Generate a name for pasted images (they don't have one)
          const ext = item.type.split('/')[1] || 'png';
          const namedFile = new File([file], `pasted-image-${Date.now()}.${ext}`, {
            type: file.type,
          });
          imageFiles.push(namedFile);
        }
      }
    }

    if (imageFiles.length > 0) {
      // Prevent default paste behavior for images
      event.preventDefault();
      await handleFiles(imageFiles);
    }
    // Let text paste through normally
  }

  /**
   * Remove attachment by index.
   */
  function removeAttachment(index: number): void {
    attachments.value.splice(index, 1);
    error.value = null;
  }

  /**
   * Clear all attachments.
   */
  function clearAttachments(): void {
    attachments.value = [];
    error.value = null;
  }

  /**
   * Get attachments for sending (strips preview URLs).
   */
  function getAttachments(): AgentAttachment[] | undefined {
    if (attachments.value.length === 0) return undefined;

    return attachments.value.map(({ type, name, mimeType, dataBase64 }) => ({
      type,
      name,
      mimeType,
      dataBase64,
    }));
  }

  return {
    // State
    attachments,
    fileInputRef,
    error,
    isDragOver,

    // Computed
    hasImages,
    canAddMore,

    // Methods
    openFilePicker,
    handleFileSelect,
    handleFiles,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    handlePaste,
    removeAttachment,
    clearAttachments,
    getAttachments,
    getPreviewUrl,
  };
}
