// keyboard-helper.js
// This script is injected into the page to handle keyboard event simulation
//
// It is the fallback for when CDP input is unavailable (the debugger cannot
// attach). Synthetic key events have no default actions, so the browser
// defaults agents depend on are reproduced here: text editing through
// beforeinput + execCommand, caret keys, Tab focus order, Enter/Space
// activation and implicit form submission. Keep it to that list: for any
// other case, fail with an explicit error instead of emulating more browser
// behaviour; the CDP path is the one that has to be faithful.

if (window.__KEYBOARD_HELPER_INITIALIZED__) {
  // Already initialized, skip
} else {
  window.__KEYBOARD_HELPER_INITIALIZED__ = true;

  // A map for special keys to their KeyboardEvent properties
  // Key names should be lowercase for matching
  const SPECIAL_KEY_MAP = {
    enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
    tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
    esc: { key: 'Escape', code: 'Escape', keyCode: 27 },
    escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
    space: { key: ' ', code: 'Space', keyCode: 32 },
    backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
    delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
    del: { key: 'Delete', code: 'Delete', keyCode: 46 },
    up: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
    arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
    down: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
    arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
    left: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
    arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
    right: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
    arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
    home: { key: 'Home', code: 'Home', keyCode: 36 },
    end: { key: 'End', code: 'End', keyCode: 35 },
    pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
    pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
    insert: { key: 'Insert', code: 'Insert', keyCode: 45 },
    // Function keys
    ...Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [
        `f${i + 1}`,
        { key: `F${i + 1}`, code: `F${i + 1}`, keyCode: 112 + i },
      ]),
    ),
  };

  const BUTTON_SELECTOR = 'button, input:is([type=button], [type=submit], [type=reset], [type=image])';
  const SPACE_CONTROL_SELECTOR = BUTTON_SELECTOR + ', input:is([type=checkbox], [type=radio])';

  const MODIFIER_KEYS = {
    ctrl: 'ctrlKey',
    control: 'ctrlKey',
    alt: 'altKey',
    shift: 'shiftKey',
    meta: 'metaKey',
    command: 'metaKey',
    cmd: 'metaKey',
  };

  /**
   * Parses a key string (e.g., "Ctrl+Shift+A", "Enter") into a main key and modifiers.
   * @param {string} keyString - String representation of a single key press (can include modifiers).
   * @returns { {key: string, code: string, keyCode: number, charCode?: number, modifiers: {ctrlKey:boolean, altKey:boolean, shiftKey:boolean, metaKey:boolean}} | null }
   *          Returns null if the keyString is invalid or represents only modifiers.
   */
  function parseSingleKeyCombination(keyString) {
    const parts = keyString.split('+').map((part) => part.trim().toLowerCase());
    const modifiers = {
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      metaKey: false,
    };
    let mainKeyPart = null;

    for (const part of parts) {
      if (MODIFIER_KEYS[part]) {
        modifiers[MODIFIER_KEYS[part]] = true;
      } else if (mainKeyPart === null) {
        // First non-modifier is the main key
        mainKeyPart = part;
      } else {
        // Invalid format: multiple main keys in a single combination (e.g., "Ctrl+A+B")
        console.error(`Invalid key combination string: ${keyString}. Multiple main keys found.`);
        return null;
      }
    }

    if (!mainKeyPart) {
      // This case could happen if the keyString is something like "Ctrl+" or just "Ctrl"
      // If the intent was to press JUST 'Control', the input should be 'Control' not 'Control+'
      // Let's check if mainKeyPart is actually a modifier name used as a main key
      if (Object.keys(MODIFIER_KEYS).includes(parts[parts.length - 1]) && parts.length === 1) {
        mainKeyPart = parts[parts.length - 1]; // e.g. user wants to press "Control" key itself
        // For "Control" key itself, key: "Control", code: "ControlLeft" (or Right)
        if (mainKeyPart === 'ctrl' || mainKeyPart === 'control')
          return { key: 'Control', code: 'ControlLeft', keyCode: 17, modifiers };
        if (mainKeyPart === 'alt') return { key: 'Alt', code: 'AltLeft', keyCode: 18, modifiers };
        if (mainKeyPart === 'shift')
          return { key: 'Shift', code: 'ShiftLeft', keyCode: 16, modifiers };
        if (mainKeyPart === 'meta' || mainKeyPart === 'command' || mainKeyPart === 'cmd')
          return { key: 'Meta', code: 'MetaLeft', keyCode: 91, modifiers };
      } else {
        console.error(`Invalid key combination string: ${keyString}. No main key specified.`);
        return null;
      }
    }

    const specialKey = SPECIAL_KEY_MAP[mainKeyPart];
    if (specialKey) {
      return { ...specialKey, modifiers };
    }

    // For single characters or other unmapped keys
    if (mainKeyPart.length === 1) {
      const charCode = mainKeyPart.charCodeAt(0);
      // If Shift is active and it's a letter, use the uppercase version for 'key'
      // This mimics more closely how keyboards behave.
      let keyChar = mainKeyPart;
      if (modifiers.shiftKey && mainKeyPart.match(/^[a-z]$/i)) {
        keyChar = mainKeyPart.toUpperCase();
      }

      return {
        key: keyChar,
        code: `Key${mainKeyPart.toUpperCase()}`, // 'a' -> KeyA, 'A' -> KeyA
        keyCode: charCode,
        charCode: charCode, // charCode is legacy, but some old systems might use it
        modifiers,
      };
    }

    console.error(`Unknown key: ${mainKeyPart} in string "${keyString}"`);
    return null; // Or handle as an error
  }

  /**
   * Simulates a single key press (keydown, (keypress), keyup) for a parsed key.
   * @param { {key: string, code: string, keyCode: number, charCode?: number, modifiers: object} } parsedKeyInfo
   * @param {Element} element - Target element.
   * @returns {{success: boolean, error?: string}}
   */
  function dispatchKeyEvents(parsedKeyInfo, element, edit, deadline) {
    if (!parsedKeyInfo) return { success: false, error: 'Invalid key info provided for dispatch.' };

    const { key, code, keyCode, charCode, modifiers } = parsedKeyInfo;

    const eventOptions = {
      key: key,
      code: code,
      bubbles: true,
      cancelable: true,
      composed: true, // Important for shadow DOM
      view: window,
      ...modifiers, // ctrlKey, altKey, shiftKey, metaKey
      // keyCode/which are deprecated but often set for compatibility
      keyCode: keyCode || (key.length === 1 ? key.charCodeAt(0) : 0),
      which: keyCode || (key.length === 1 ? key.charCodeAt(0) : 0),
    };

    try {
      let allowEdit = element.dispatchEvent(new KeyboardEvent('keydown', eventOptions));

      // keypress is deprecated, but simulate if it's a character key or Enter
      // Only dispatch if keydown was not cancelled, no command modifier is held,
      // and it's a character producing key.
      const commandHeld = Boolean(modifiers?.ctrlKey || modifiers?.metaKey || modifiers?.altKey);
      if (allowEdit && !commandHeld && (key.length === 1 || key === 'Enter' || key === ' ')) {
        const keypressOptions = { ...eventOptions };
        if (charCode) keypressOptions.charCode = charCode;
        allowEdit = element.dispatchEvent(new KeyboardEvent('keypress', keypressOptions));
      }

      const activateOnRelease = key === ' ' && !commandHeld && element.matches(SPACE_CONTROL_SELECTOR);
      let releaseAllowed = false;
      let expired = false;
      try {
        if (Date.now() >= deadline) {
          expired = true;
          throw new Error('Keyboard operation expired');
        }
        if (allowEdit && !activateOnRelease) edit?.();
      } finally {
        if (!expired && !(Date.now() >= deadline)) {
          const releaseTarget = focusedElement();
          releaseAllowed =
            Boolean(releaseTarget) &&
            releaseTarget.dispatchEvent(new KeyboardEvent('keyup', eventOptions)) &&
            releaseTarget === element;
        }
      }
      if (activateOnRelease && allowEdit && releaseAllowed && focusedElement() === element) {
        if (Date.now() >= deadline) throw new Error('Keyboard operation expired');
        edit?.();
      }
      return { success: true };
    } catch (error) {
      console.error(`Error dispatching key events for "${key}":`, error);
      return {
        success: false,
        error: `Error dispatching key events for "${key}": ${error.message}`,
      };
    }
  }

  function focusedElement() {
    let element = document.activeElement || document.body || document.documentElement;
    while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
    return element;
  }

  function isTabCandidate(node) {
    if (!(node instanceof HTMLElement) || node.closest('[inert], [hidden]') ||
        node.matches(':disabled, input[type=hidden]')) return false;
    if (node.checkVisibility && !node.checkVisibility({ visibilityProperty: true })) return false;
    if (node.tabIndex >= 0) return true;
    if (!node.hasAttribute('tabindex') && node.isContentEditable && !node.parentElement?.isContentEditable) {
      return true;
    }
    return false;
  }

  function shadowRootHasFocusable(shadowRoot) {
    if (shadowRoot.delegatesFocus) return true;
    for (const child of shadowRoot.querySelectorAll('*')) {
      if (isTabCandidate(child)) return true;
      if (child.shadowRoot && shadowRootHasFocusable(child.shadowRoot)) return true;
    }
    return false;
  }

  function moveTabFocus(element, backward) {
    const root = element.getRootNode();
    // A shadow host with focusable descendants or a frame is a focus-navigation
    // boundary. Don't skip it and apply subsequent keys to an unrelated control.
    const candidates = Array.from(root.querySelectorAll('*')).filter((node) => {
      if (isTabCandidate(node)) return true;
      if (
        node instanceof HTMLElement &&
        !node.closest('[inert], [hidden]') &&
        !node.matches(':disabled') &&
        (!node.checkVisibility || node.checkVisibility({ visibilityProperty: true })) &&
        !node.hasAttribute('tabindex') &&
        node.shadowRoot &&
        shadowRootHasFocusable(node.shadowRoot)
      ) {
        return true;
      }
      return false;
    });
    const stops = candidates.filter((node) => {
      if (!node.matches('input[type=radio]') || !node.name) return true;
      const group = candidates.filter((other) => other.type === 'radio' &&
        other.name === node.name && other.form === node.form);
      const activeInGroup = group.includes(element) ? element : null;
      return node === (group.find((radio) => radio.checked) ||
        activeInGroup ||
        (backward ? group[group.length - 1] : group[0]));
    });
    const rank = (node) => node.tabIndex > 0 ? node.tabIndex : Infinity;
    stops.sort((a, b) => rank(a) - rank(b));
    const index = stops.indexOf(element);
    let next;
    if (index >= 0) {
      next = stops[index + (backward ? -1 : 1)];
    } else if (element === document.body || element === document.documentElement) {
      next = stops[backward ? stops.length - 1 : 0];
    } else {
      // Programmatically focused container (e.g. tabindex="-1"): advance in tree order.
      const naturalStops = stops.filter((node) => node.tabIndex <= 0);
      if (backward) {
        for (let i = naturalStops.length - 1; i >= 0; i -= 1) {
          if (element.compareDocumentPosition(naturalStops[i]) & Node.DOCUMENT_POSITION_PRECEDING) {
            next = naturalStops[i];
            break;
          }
        }
      } else {
        for (let i = 0; i < naturalStops.length; i += 1) {
          if (element.compareDocumentPosition(naturalStops[i]) & Node.DOCUMENT_POSITION_FOLLOWING) {
            next = naturalStops[i];
            break;
          }
        }
      }
    }
    if (!next || next.matches('iframe, frame, object, embed') || (next.shadowRoot && shadowRootHasFocusable(next.shadowRoot))) {
      throw new Error('Tab leaves the available focus scope; use an explicit element ref');
    }
    next.focus();
    if (focusedElement() !== next) throw new Error('The next control did not receive focus');
    if (next.matches('input:is([type=text], [type=search], [type=url], [type=tel], [type=password], :not([type]))')) {
      next.select();
    }
  }

  function submitImplicitly(form) {
    // The default submitter is the first submit button in tree order, including
    // buttons associated via form="...". Its click may be disabled or cancelled.
    const controls = Array.from(form.getRootNode().querySelectorAll('input, button'))
      .filter((control) => control.form === form);
    const submitter = controls.find((control) => control.type === 'submit' || control.type === 'image');
    if (submitter) {
      submitter.click();
      return;
    }
    const blockingTypes = ['text', 'search', 'url', 'tel', 'email', 'password', 'date',
      'month', 'week', 'time', 'datetime-local', 'number'];
    if (controls.filter((control) => blockingTypes.includes(control.type)).length <= 1) {
      HTMLFormElement.prototype.requestSubmit.call(form);
    }
  }

  function isTextField(element) {
    return element.isContentEditable || element.tagName === 'TEXTAREA' ||
      (element.tagName === 'INPUT' &&
       ['text', 'search', 'url', 'tel', 'email', 'password', 'number'].includes(element.type));
  }

  function editText(element, command, data, deadline) {
    if (!isTextField(element) || element.readOnly || element.matches(':disabled')) {
      throw new Error('The focused element is not editable');
    }
    if (focusedElement() !== element) throw new Error('The editing target lost focus');
    const inputTypes = {
      insertText: 'insertText', delete: 'deleteContentBackward',
      forwardDelete: 'deleteContentForward', insertLineBreak: 'insertLineBreak',
    };
    const allowed = element.dispatchEvent(new InputEvent('beforeinput', {
      bubbles: true, composed: true, cancelable: true, inputType: inputTypes[command], data: data ?? null,
    }));
    if (!allowed) return;
    if (Date.now() >= deadline) throw new Error('Keyboard operation expired');
    if (focusedElement() !== element) throw new Error('The editing target lost focus');
    if (!document.execCommand(command, false, data)) {
      throw new Error('The focused element did not accept the editing command: ' + command);
    }
  }

  function applyEdit(element, key, modifiers, text, deadline) {
    if (key === 'Tab' && !modifiers.ctrlKey && !modifiers.altKey && !modifiers.metaKey) {
      moveTabFocus(element, modifiers.shiftKey);
      return;
    }
    if (!isTextField(element)) {
      if (modifiers.ctrlKey || modifiers.altKey || modifiers.metaKey) return;
      if ((key === 'Enter' && element.matches(BUTTON_SELECTOR + ', a[href]')) ||
          (key === ' ' && element.matches(SPACE_CONTROL_SELECTOR))) {
        element.click();
      }
      return;
    }
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(key)) {
      const selection = element.ownerDocument.getSelection();
      if (!selection?.modify) throw new Error('The browser cannot move the caret in this field');
      const mac = /mac/i.test(navigator.platform);
      const word = mac ? modifiers.altKey : modifiers.ctrlKey;
      const lineEdge = key === 'Home' || key === 'End' || mac && modifiers.metaKey;
      let granularity = word ? 'word' : 'character';
      let direction = key === 'ArrowLeft' ? 'left' : 'right';
      if (lineEdge || key === 'ArrowUp' || key === 'ArrowDown') {
        direction = ['Home', 'ArrowLeft', 'ArrowUp'].includes(key) ? 'backward' : 'forward';
        granularity = lineEdge ? 'lineboundary' : 'line';
        if ((key === 'Home' || key === 'End') && modifiers.ctrlKey ||
            mac && modifiers.metaKey && (key === 'ArrowUp' || key === 'ArrowDown')) {
          granularity = 'documentboundary';
        }
      }
      selection.modify(modifiers.shiftKey ? 'extend' : 'move', direction, granularity);
      return;
    }
    const commandKey = modifiers.ctrlKey || modifiers.metaKey;
    let command;
    if (commandKey && !modifiers.altKey && !modifiers.shiftKey && key.toLowerCase() === 'a') command = 'selectAll';
    else if (!commandKey && !modifiers.altKey) {
      if (text !== undefined) command = 'insertText';
      else if (key === 'Backspace') command = 'delete';
      else if (key === 'Delete') command = 'forwardDelete';
      else if (key === 'Enter' && element.matches('input') && element.form) {
        submitImplicitly(element.form);
        return;
      } else if (key === 'Enter' && (element.matches('textarea') || element.isContentEditable)) {
        command = 'insertLineBreak';
      }
    }
    if (command === 'selectAll') {
      if (!document.execCommand(command)) throw new Error('Could not select the field contents');
    } else if (command) {
      editText(element, command, text, deadline);
    }
  }

  function dispatchStep(step, element, deadline) {
    if (step.kind === 'text') {
      // Match Input.insertText: the editor can veto the entire literal insertion.
      editText(element, 'insertText', step.text, deadline);
      return { success: true };
    }
    const { key: definition, modifiers: names } = step.stroke;
    const modifiers = Object.fromEntries(names.map((name) => [name + 'Key', true]));
    const key = (modifiers.shiftKey && definition.shiftKey) || definition.key;
    const text = definition.text !== undefined && key !== 'Enter' ? key : undefined;
    return dispatchKeyEvents({ ...definition, key, modifiers }, element,
      () => applyEdit(element, key, modifiers, text, deadline), deadline);
  }

  /**
   * Simulate keyboard events on an element or document
   * @param {string} keysSequenceString - String representation of key(s) (e.g., "Enter", "Ctrl+C, A, B")
   * @param {Element} targetElement - Element to dispatch events on (optional)
   * @param {number} delay - Delay between key sequences in milliseconds (optional)
   * @returns {Promise<Object>} - Result of the keyboard operation
   */
  async function simulateKeyboard(keysSequenceString, targetElement = null, delay = 0, steps, deadline) {
    try {
      const active = focusedElement();
      const element = targetElement || active;
      if (element !== active && typeof element.focus === 'function') {
        element.focus();
        await new Promise((resolve) => setTimeout(resolve, 50)); // Small delay for focus
      }

      const keyCombinations = steps ?? keysSequenceString
        .split(',')
        .map((k) => k.trim())
        .filter((k) => k.length > 0);
      const operationResults = [];

      for (let i = 0; i < keyCombinations.length; i++) {
        if (Date.now() >= deadline) throw new Error('Keyboard operation expired');
        const step = keyCombinations[i];
        const comboString = steps ? (step.token ?? step.text) : step;
        const dispatchResult = steps
          ? dispatchStep(step, focusedElement(), deadline)
          : dispatchKeyEvents(parseSingleKeyCombination(comboString), element);
        operationResults.push({
          keyCombination: comboString,
          ...dispatchResult,
        });

        if (steps && dispatchResult.error) break;

        if (delay > 0 && i < keyCombinations.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }

      // Check if all individual operations were successful
      const overallSuccess = operationResults.every((r) => r.success);

      return {
        success: overallSuccess,
        ...(!overallSuccess && { error: operationResults.find((result) => !result.success)?.error }),
        message: overallSuccess
          ? `Keyboard events simulated successfully: ${keysSequenceString}`
          : `Some keyboard events failed for: ${keysSequenceString}`,
        results: operationResults, // Detailed results for each key combination
        targetElement: {
          tagName: element.tagName,
          id: element.id,
          className: element.className,
          type: element.type, // if applicable e.g. for input
        },
      };
    } catch (error) {
      console.error('Error in simulateKeyboard:', error);
      return {
        success: false,
        error: `Error simulating keyboard events: ${error.message}`,
        results: [],
      };
    }
  }

  // Listener for messages from the extension
  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (request.action === 'simulateKeyboard') {
      let targetEl = null;
      if (request.selector) {
        targetEl = document.querySelector(request.selector);
        if (!targetEl) {
          sendResponse({
            success: false,
            error: `Element with selector "${request.selector}" not found`,
            results: [],
          });
          return true; // Keep channel open for async response
        }
      }

      simulateKeyboard(request.keys, targetEl, request.delay, request.steps, request.deadline)
        .then(sendResponse)
        .catch((error) => {
          // This catch is for unexpected errors in simulateKeyboard promise chain itself
          console.error('Unexpected error in simulateKeyboard promise chain:', error);
          sendResponse({
            success: false,
            error: `Unexpected error during keyboard simulation: ${error.message}`,
            results: [],
          });
        });
      return true; // Indicates async response is expected
    } else if (request.action === 'chrome_keyboard_ping') {
      sendResponse({ status: 'pong', initialized: true }); // Respond that it's initialized
      return false; // Synchronous response
    }
    // Not our message, or no async response needed
    return false;
  });
}
