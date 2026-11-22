import type { ToolResult } from '@/common/tool-handler';

export function readScreenshotData(result: ToolResult): { data: string } | { error: string } {
  const content = Array.isArray(result?.content) ? result.content : [];
  const rawText = content.find(
    (block): block is { type: 'text'; text: string } =>
      block?.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0,
  )?.text;
  if (result?.isError) return { error: rawText?.trim() || 'screenshot failed' };

  const image = content.find((block) => block?.type === 'image');
  if (image && 'data' in image && typeof image.data === 'string' && image.data.length > 0) {
    return { data: image.data };
  }
  if (!rawText) return { error: 'screenshot tool returned an empty response' };
  try {
    const data = JSON.parse(rawText)?.base64Data;
    if (typeof data === 'string' && data.length > 0) return { data };
  } catch {
    return { error: 'screenshot tool returned invalid JSON' };
  }
  return { error: 'screenshot tool returned empty base64Data' };
}
