import { describe, expect, it, vi } from 'vitest';
import {
  BUILDER_IMPORT_LIMITS,
  readBuilderImportCandidates,
} from '@/entrypoints/builder/import-boundaries';

function importFile(text: string, size = text.length) {
  return {
    size,
    text: vi.fn().mockResolvedValue(text),
  };
}

function builderFlow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'flow-1',
    name: 'Imported flow',
    version: 1,
    steps: [],
    ...overrides,
  };
}

describe('builder import resource boundaries', () => {
  it('rejects an oversized file before decoding it', async () => {
    const file = importFile('{}', BUILDER_IMPORT_LIMITS.maxFileBytes + 1);

    await expect(readBuilderImportCandidates(file)).rejects.toThrow(/file exceeds/i);
    expect(file.text).not.toHaveBeenCalled();
  });

  it('accepts normal builder and V3 workflows', async () => {
    const builder = builderFlow();
    const v3 = {
      schemaVersion: 3,
      id: 'flow-v3',
      name: 'V3 flow',
      entryNodeId: 'node-1',
      nodes: [{ id: 'node-1', kind: 'navigate', config: {} }],
      edges: [],
    };

    await expect(
      readBuilderImportCandidates(importFile(JSON.stringify({ flows: [builder, v3] }))),
    ).resolves.toEqual([builder, v3]);
  });

  it('rejects excessive JSON depth before parsing', async () => {
    const depth = BUILDER_IMPORT_LIMITS.maxJsonDepth + 1;
    const text = `${'['.repeat(depth)}null${']'.repeat(depth)}`;

    await expect(readBuilderImportCandidates(importFile(text))).rejects.toThrow(/depth limit/i);
  });

  it('rejects an excessive JSON value graph before conversion', async () => {
    const flow = builderFlow({
      data: Array.from({ length: BUILDER_IMPORT_LIMITS.maxJsonValues + 1 }, () => null),
    });
    const text = JSON.stringify(flow);

    await expect(readBuilderImportCandidates(importFile(text))).rejects.toThrow(/value JSON limit/i);
  });

  it('rejects too many flow candidates before inspecting them', async () => {
    const flows = Array.from(
      { length: BUILDER_IMPORT_LIMITS.maxCandidates + 1 },
      (_, index) => builderFlow({ id: `flow-${index}` }),
    );
    const text = JSON.stringify(flows);

    await expect(readBuilderImportCandidates(importFile(text))).rejects.toThrow(/candidate limit/i);
  });

  it.each([
    ['nodes', BUILDER_IMPORT_LIMITS.maxNodes + 1],
    ['steps', BUILDER_IMPORT_LIMITS.maxSteps + 1],
    ['edges', BUILDER_IMPORT_LIMITS.maxEdges + 1],
  ] as const)('rejects an oversized %s array before flow conversion', async (field, length) => {
    const flow = builderFlow({ [field]: Array.from({ length }, () => ({})) });
    const text = JSON.stringify(flow);

    await expect(readBuilderImportCandidates(importFile(text))).rejects.toThrow(
      new RegExp(`${field} exceeds`, 'i'),
    );
  });

  it('bounds aggregate graph size across subflows', async () => {
    const flow = builderFlow({
      nodes: Array.from({ length: BUILDER_IMPORT_LIMITS.maxNodes }, () => ({})),
      subflows: { child: { nodes: [{}], edges: [] } },
    });
    const text = JSON.stringify(flow);

    await expect(readBuilderImportCandidates(importFile(text))).rejects.toThrow(
      /total nodes exceeds/i,
    );
  });
});
