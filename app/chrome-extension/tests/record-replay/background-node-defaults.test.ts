import { describe, expect, it, beforeAll } from 'vitest';
import {
  STEP_TYPES,
  getNodeSpec,
  mapNodeToStep,
  registerBuiltinSpecs,
} from 'webpage-mcp-shared';

describe('background node defaults', () => {
  beforeAll(() => {
    registerBuiltinSpecs();
  });

  it('does not persist background=false in node defaults', () => {
    for (const type of [
      STEP_TYPES.NAVIGATE,
      STEP_TYPES.SCREENSHOT,
      STEP_TYPES.OPEN_TAB,
      STEP_TYPES.SWITCH_TAB,
    ]) {
      expect(getNodeSpec(type)?.defaults).not.toHaveProperty('background');
    }
  });

  it('omits inherited background mode unless it is explicitly configured', () => {
    const inherited = mapNodeToStep({
      id: 'navigate_inherit',
      type: STEP_TYPES.NAVIGATE,
      config: { url: 'https://example.com/' },
    });
    const explicitForeground = mapNodeToStep({
      id: 'navigate_foreground',
      type: STEP_TYPES.NAVIGATE,
      config: { url: 'https://example.com/', background: false },
    });

    expect(inherited).not.toHaveProperty('background');
    expect(explicitForeground).toMatchObject({ background: false });
  });
});
