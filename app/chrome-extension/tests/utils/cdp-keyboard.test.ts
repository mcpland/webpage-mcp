import { describe, expect, it, vi } from 'vitest';
import {
  dispatchKeyStroke,
  parseKeyboardInput,
  parseKeySequence,
  parseKeyStroke,
} from '@/utils/cdp-keyboard';

async function eventsFor(token: string, mac = false) {
  const stroke = parseKeyStroke(token);
  if (!stroke) throw new Error(`unparsed ${token}`);
  const dispatch = vi.fn().mockResolvedValue(undefined);
  await dispatchKeyStroke(dispatch, stroke, { mac });
  return dispatch.mock.calls.map(([event]) => event);
}

describe('dispatchKeyStroke', () => {
  it('sends Enter with its virtual key code and carriage return text', async () => {
    const [down, up] = await eventsFor('Enter');
    expect(down).toEqual({
      type: 'keyDown',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      text: '\r',
      unmodifiedText: '\r',
      modifiers: 0,
      location: 0,
    });
    expect(up).toMatchObject({ type: 'keyUp', key: 'Enter', windowsVirtualKeyCode: 13 });
  });

  it('sends non-printing keys as raw key downs with key codes', async () => {
    const [down] = await eventsFor('Backspace');
    expect(down).toMatchObject({ type: 'rawKeyDown', key: 'Backspace', windowsVirtualKeyCode: 8 });
    expect(down).not.toHaveProperty('text');
  });

  it('holds modifier keys around a chord and suppresses characters', async () => {
    const events = await eventsFor('ctrl+a');
    expect(events.map((event) => [event.type, event.key, event.modifiers])).toEqual([
      ['rawKeyDown', 'Control', 2],
      ['rawKeyDown', 'a', 2],
      ['keyUp', 'a', 2],
      ['keyUp', 'Control', 0],
    ]);
    expect(events[1]).toMatchObject({ code: 'KeyA', windowsVirtualKeyCode: 65 });
    expect(events[1]).not.toHaveProperty('text');
  });

  it('adds editing commands for select-all style shortcuts', async () => {
    expect((await eventsFor('cmd+a', true))[1].commands).toEqual(['selectAll']);
    expect((await eventsFor('ctrl+a', true))[1].commands).toEqual(['selectAll']);
    expect((await eventsFor('cmd+shift+z', true))[2].commands).toEqual(['redo']);
    expect((await eventsFor('cmd+v', false))[1].commands).toEqual(['paste']);
    // Ctrl shortcuts already work natively outside macOS.
    expect((await eventsFor('ctrl+a', false))[1]).not.toHaveProperty('commands');
  });

  it('applies Shift to characters', async () => {
    const events = await eventsFor('shift+a');
    expect(events[1]).toMatchObject({ type: 'keyDown', key: 'A', text: 'A', modifiers: 8 });
  });

  it('types single characters with keydown text', async () => {
    const [down] = await eventsFor('a');
    expect(down).toMatchObject({ type: 'keyDown', key: 'a', code: 'KeyA', text: 'a' });
  });

  it('normalizes uppercase letters in command chords when Shift is not held', async () => {
    const cmdK = await eventsFor('Cmd+K', true);
    expect(cmdK[1]).toMatchObject({ type: 'rawKeyDown', key: 'k', code: 'KeyK', modifiers: 4 });
    const cmdShiftK = await eventsFor('Cmd+Shift+K', true);
    expect(cmdShiftK[2]).toMatchObject({ type: 'rawKeyDown', key: 'K', code: 'KeyK', modifiers: 12 });
  });

  it('supports standalone modifier aliases, includes modifier bit on down, and deduplicates repeats', async () => {
    const superEvents = await eventsFor('Super');
    expect(superEvents[0]).toMatchObject({ type: 'rawKeyDown', key: 'Meta', modifiers: 4 });
    expect(superEvents[1]).toMatchObject({ type: 'keyUp', key: 'Meta', modifiers: 0 });
    expect((await eventsFor('Opt'))[0]).toMatchObject({ key: 'Alt', modifiers: 1 });
    expect((await eventsFor('Win'))[0]).toMatchObject({ key: 'Meta', modifiers: 4 });
    expect((await eventsFor('Ctrl+Ctrl')).map((e) => [e.type, e.key, e.modifiers])).toEqual([
      ['rawKeyDown', 'Control', 2],
      ['keyUp', 'Control', 0],
    ]);
  });
});

describe('parseKeyboardInput', () => {
  const kinds = (input: string) =>
    parseKeyboardInput(input).map((step) =>
      step.kind === 'text' ? `text:${step.text}` : `key:${step.token}`,
    );

  it('keeps named keys and chords as key strokes', () => {
    expect(kinds('Enter')).toEqual(['key:Enter']);
    expect(kinds('Shift+Tab')).toEqual(['key:Shift+Tab']);
    expect(kinds('Ctrl+A Backspace')).toEqual(['key:Ctrl+A', 'key:Backspace']);
    expect(kinds('Tab,Tab,Enter')).toEqual(['key:Tab', 'key:Tab', 'key:Enter']);
    expect(kinds('a,b,c')).toEqual(['key:a', 'key:b', 'key:c']);
    expect(kinds('ctrl++')).toEqual(['key:ctrl++']);
  });

  it('types anything else literally', () => {
    expect(kinds('Hello World')).toEqual(['text:Hello World']);
    expect(kinds('Hello, World')).toEqual(['text:Hello, World']);
    expect(kinds('a b')).toEqual(['text:a b']);
    expect(kinds(' ')).toEqual(['text: ']);
    expect(kinds(' a ')).toEqual(['text: a ']);
    expect(kinds('a,,b')).toEqual(['text:a,,b']);
  });
});

describe('parseKeySequence', () => {
  it('reports unknown tokens instead of sending them as keys', () => {
    const { strokes, unknown } = parseKeySequence('Backspace Hello Enter');
    expect(strokes).toHaveLength(2);
    expect(unknown).toEqual(['Hello']);
  });
});
