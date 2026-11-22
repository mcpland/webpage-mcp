import type { ToolResult } from '@/common/tool-handler';

export function readScreenshotData(result: ToolResult): { data: string } | { error: string } {
  const text = result.content.find((block) => block.type === 'text')?.text;
  if (result.isError) return { error: text || 'screenshot failed' };

  const image = result.content.find((block) => block.type === 'image');
  if (image?.data) return { data: image.data };
  if (!text) return { error: 'screenshot tool returned an empty response' };
  try {
    const data = JSON.parse(text)?.base64Data;
    if (typeof data === 'string' && data.length > 0) return { data };
  } catch {
    return { error: 'screenshot tool returned invalid JSON' };
  }
  return { error: 'screenshot tool returned empty base64Data' };
}
