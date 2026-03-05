export type DatasetRow = Record<string, unknown>;

export interface ParsedRunDataset {
  rows: DatasetRow[];
  source: 'dataset' | 'datasetJson' | 'datasetCsv';
}

interface ParseDatasetError {
  error: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeRows(value: unknown, source: ParsedRunDataset['source']): ParsedRunDataset | ParseDatasetError {
  if (Array.isArray(value)) {
    const rows: DatasetRow[] = [];
    for (let i = 0; i < value.length; i += 1) {
      const row = value[i];
      if (!isRecord(row)) {
        return { error: `${source}[${i}] must be an object` };
      }
      rows.push({ ...row });
    }
    if (rows.length === 0) {
      return { error: `${source} must contain at least one row` };
    }
    return { rows, source };
  }

  if (isRecord(value)) {
    return { rows: [{ ...value }], source };
  }

  return { error: `${source} must be an object or array of objects` };
}

function parseJsonRows(jsonText: string): ParsedRunDataset | ParseDatasetError {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return { error: `datasetJson parse failed: ${message}` };
  }
  return normalizeRows(parsed, 'datasetJson');
}

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === ',' && !inQuotes) {
      values.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  values.push(current);
  return values;
}

function parseCsvRows(csvText: string): ParsedRunDataset | ParseDatasetError {
  const lines = String(csvText || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length < 2) {
    return { error: 'datasetCsv must contain a header and at least one data row' };
  }

  const headers = parseCsvLine(lines[0]).map((h) => h.trim());
  if (headers.some((header) => header.length === 0)) {
    return { error: 'datasetCsv header contains empty column names' };
  }

  const rows: DatasetRow[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cells = parseCsvLine(lines[i]);
    if (cells.length !== headers.length) {
      return {
        error: `datasetCsv row ${i} has ${cells.length} columns, expected ${headers.length}`,
      };
    }
    const row: DatasetRow = {};
    for (let c = 0; c < headers.length; c += 1) {
      row[headers[c]] = cells[c];
    }
    rows.push(row);
  }

  if (rows.length === 0) {
    return { error: 'datasetCsv must contain at least one data row' };
  }

  return { rows, source: 'datasetCsv' };
}

export function parseRunDatasetInput(args: unknown): ParsedRunDataset | null | ParseDatasetError {
  if (!isRecord(args)) return null;

  if (args.dataset !== undefined) {
    return normalizeRows(args.dataset, 'dataset');
  }

  if (typeof args.datasetJson === 'string' && args.datasetJson.trim()) {
    return parseJsonRows(args.datasetJson);
  }

  if (typeof args.datasetCsv === 'string' && args.datasetCsv.trim()) {
    return parseCsvRows(args.datasetCsv);
  }

  return null;
}
