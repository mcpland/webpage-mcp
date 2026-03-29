export function toDownloadDisplayName(filename?: string | null): string | undefined {
  if (typeof filename !== 'string' || !filename) {
    return undefined;
  }

  const normalized = filename.split(/[/\\]/).pop();
  return normalized || filename;
}

export function toPublicDownloadLocation(
  value?: {
    filename?: string | null;
    fullPath?: string | null;
  } | null,
): { filename?: string; pathRedacted: true } {
  return {
    filename: toDownloadDisplayName(value?.filename ?? value?.fullPath),
    pathRedacted: true,
  };
}
