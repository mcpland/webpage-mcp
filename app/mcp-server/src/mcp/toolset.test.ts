import { TOOL_SCHEMAS } from 'webpage-mcp-shared';
import { describe, expect, it } from 'vitest';
import { parseToolset, TOOLSET_PROFILES } from './toolset';

const allNames = [...TOOL_SCHEMAS.map((tool) => tool.name), 'workflow_run'];
const enabled = (spec: string | undefined) => allNames.filter((name) => parseToolset(spec).allows(name));

describe('parseToolset', () => {
  it('enables every tool by default', () => {
    expect(enabled(undefined)).toEqual(allNames);
    expect(enabled('')).toEqual(allNames);
    expect(enabled(' all ')).toEqual(allNames);
    expect(parseToolset('all').allows('some_future_tool')).toBe(true);
  });

  it('narrows to a profile, plus individually named tools', () => {
    expect(enabled('core')).toEqual(allNames.filter((name) => TOOLSET_PROFILES.core.includes(name)));
    expect(enabled('core')).toContain('chrome_read_page');
    expect(enabled('core')).not.toContain('chrome_console');
    expect(enabled('core, chrome_console')).toContain('chrome_console');
    expect(enabled('browser').some((name) => name.startsWith('workflow_'))).toBe(false);
    expect(enabled('workflow')).toContain('workflow_run');
    expect(enabled('workflow')).not.toContain('chrome_navigate');
  });

  it('applies removals over additions, starting from all when only removing', () => {
    expect(enabled('-chrome_gif_recorder')).toEqual(allNames.filter((n) => n !== 'chrome_gif_recorder'));
    expect(enabled('all,-workflow')).toEqual(enabled('browser'));
    expect(enabled('core,-chrome_javascript')).not.toContain('chrome_javascript');
  });

  it('treats legacy flow.<slug> tools as part of workflow_run', () => {
    expect(parseToolset('workflow').allows('flow.signup')).toBe(true);
    expect(parseToolset('core').allows('flow.signup')).toBe(false);
  });

  it('reports entries it ignores', () => {
    const toolset = parseToolset('core,chrome_nope,-all');
    expect(toolset.warnings).toEqual([
      expect.stringContaining('unknown entry "chrome_nope" ignored'),
      '"-all" is not supported and was ignored',
    ]);
    expect(toolset.allows('chrome_navigate')).toBe(true);
  });

  it('keeps the core profile small', () => {
    const coreBytes = JSON.stringify(TOOL_SCHEMAS.filter((t) => TOOLSET_PROFILES.core.includes(t.name))).length;
    const allBytes = JSON.stringify(TOOL_SCHEMAS).length;
    expect(coreBytes / allBytes).toBeLessThan(0.5);
  });
});
