import { describe, expect, it } from 'vitest';
import { parseRunDatasetInput } from '@/entrypoints/background/tools/flow-run-dataset';

describe('flow run dataset parser', () => {
  it('parses object dataset as single row', () => {
    const parsed = parseRunDatasetInput({ dataset: { username: 'alice', age: 18 } });
    expect(parsed && 'rows' in parsed).toBe(true);
    if (!parsed || !('rows' in parsed)) return;
    expect(parsed.source).toBe('dataset');
    expect(parsed.rows).toEqual([{ username: 'alice', age: 18 }]);
  });

  it('parses datasetJson array', () => {
    const parsed = parseRunDatasetInput({ datasetJson: '[{"q":"a"},{"q":"b"}]' });
    expect(parsed && 'rows' in parsed).toBe(true);
    if (!parsed || !('rows' in parsed)) return;
    expect(parsed.source).toBe('datasetJson');
    expect(parsed.rows).toEqual([{ q: 'a' }, { q: 'b' }]);
  });

  it('parses datasetCsv and preserves cell strings', () => {
    const parsed = parseRunDatasetInput({
      datasetCsv: 'name,age,active\nAlice,20,true\nBob,31,false',
    });
    expect(parsed && 'rows' in parsed).toBe(true);
    if (!parsed || !('rows' in parsed)) return;
    expect(parsed.source).toBe('datasetCsv');
    expect(parsed.rows).toEqual([
      { name: 'Alice', age: '20', active: 'true' },
      { name: 'Bob', age: '31', active: 'false' },
    ]);
  });

  it('returns parse error for invalid csv columns', () => {
    const parsed = parseRunDatasetInput({ datasetCsv: 'a,b\n1' });
    expect(parsed && 'error' in parsed).toBe(true);
    if (!parsed || !('error' in parsed)) return;
    expect(parsed.error).toContain('datasetCsv row 1 has 1 columns, expected 2');
  });

  it('keeps leading zeros for csv cell values', () => {
    const parsed = parseRunDatasetInput({
      datasetCsv: 'code,pin\n00123,0007',
    });
    expect(parsed && 'rows' in parsed).toBe(true);
    if (!parsed || !('rows' in parsed)) return;
    expect(parsed.rows).toEqual([{ code: '00123', pin: '0007' }]);
  });
});
