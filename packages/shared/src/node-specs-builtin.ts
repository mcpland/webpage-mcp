// node-specs-builtin.ts — builtin NodeSpecs shared for UI + runtime
import type { NodeSpec } from "./node-spec";
import { registerNodeSpec } from "./node-spec-registry";
import { STEP_TYPES } from "./step-types";

export function registerBuiltinSpecs() {
  const nav: NodeSpec = {
    type: STEP_TYPES.NAVIGATE,
    version: 1,
    display: {
      label: "Navigate",
      iconClass: "icon-navigate",
      category: "Actions",
    },
    ports: { inputs: 1, outputs: [{ label: "default" }] },
    schema: [
      {
        key: "url",
        label: "URL",
        type: "string",
        required: true,
        placeholder: "https://example.com",
        help: "Target URL, supports variable template {var}",
        default: "",
      },
      {
        key: "background",
        label: "Background",
        type: "boolean",
      },
    ],
    defaults: { url: "" },
    validate: (cfg) => {
      const errs: string[] = [];
      if (!cfg || !cfg.url || String(cfg.url).trim() === "")
        errs.push("URL is required");
      return errs;
    },
  };
  registerNodeSpec(nav);

  // Click / Dblclick
  registerNodeSpec({
    type: STEP_TYPES.CLICK,
    version: 1,
    display: { label: "Click", iconClass: "icon-click", category: "Actions" },
    ports: { inputs: 1, outputs: [{ label: "default" }] },
    schema: [
      {
        key: "target",
        label: "Target",
        type: "json",
        widget: "targetlocator",
        help: "Select or enter element selector",
      },
      {
        key: "before",
        label: "Before",
        type: "object",
        fields: [
          {
            key: "scrollIntoView",
            label: "Scroll Into View",
            type: "boolean",
            default: true,
          },
          {
            key: "waitForSelector",
            label: "Wait For Selector",
            type: "boolean",
            default: true,
          },
        ],
      },
      {
        key: "after",
        label: "After",
        type: "object",
        fields: [
          {
            key: "waitForNavigation",
            label: "Wait For Navigation",
            type: "boolean",
            default: false,
          },
          {
            key: "waitForNetworkIdle",
            label: "Wait For Network Idle",
            type: "boolean",
            default: false,
          },
        ],
      },
    ],
    defaults: {
      before: { scrollIntoView: true, waitForSelector: true },
      after: {},
    },
  });
  registerNodeSpec({
    type: STEP_TYPES.DBLCLICK,
    version: 1,
    display: {
      label: "Double Click",
      iconClass: "icon-click",
      category: "Actions",
    },
    ports: { inputs: 1, outputs: [{ label: "default" }] },
    schema: [
      { key: "target", label: "Target", type: "json", widget: "targetlocator" },
      {
        key: "before",
        label: "Before",
        type: "object",
        fields: [
          {
            key: "scrollIntoView",
            label: "Scroll Into View",
            type: "boolean",
            default: true,
          },
          {
            key: "waitForSelector",
            label: "Wait For Selector",
            type: "boolean",
            default: true,
          },
        ],
      },
      {
        key: "after",
        label: "After",
        type: "object",
        fields: [
          {
            key: "waitForNavigation",
            label: "Wait For Navigation",
            type: "boolean",
            default: false,
          },
          {
            key: "waitForNetworkIdle",
            label: "Wait For Network Idle",
            type: "boolean",
            default: false,
          },
        ],
      },
    ],
    defaults: {
      before: { scrollIntoView: true, waitForSelector: true },
      after: {},
    },
  });

  // Fill
  registerNodeSpec({
    type: STEP_TYPES.FILL,
    version: 1,
    display: { label: "Fill", iconClass: "icon-fill", category: "Actions" },
    ports: { inputs: 1, outputs: [{ label: "default" }] },
    schema: [
      { key: "target", label: "Target", type: "json", widget: "targetlocator" },
      {
        key: "value",
        label: "Value",
        type: "string",
        required: true,
        help: "Supports {var} template",
      },
    ],
    defaults: { value: "" },
  });

  // Key
  registerNodeSpec({
    type: STEP_TYPES.KEY,
    version: 1,
    display: { label: "Keyboard", iconClass: "icon-key", category: "Actions" },
    ports: { inputs: 1, outputs: [{ label: "default" }] },
    schema: [
      {
        key: "keys",
        label: "Key Sequence",
        type: "string",
        widget: "keysequence",
        required: true,
        help: "e.g. Backspace Enter or cmd+a",
      },
      {
        key: "target",
        label: "Focus Target (optional)",
        type: "json",
        widget: "targetlocator",
      },
    ],
    defaults: { keys: "" },
  });

  // Scroll
  registerNodeSpec({
    type: STEP_TYPES.SCROLL,
    version: 1,
    display: { label: "Scroll", iconClass: "icon-scroll", category: "Actions" },
    ports: { inputs: 1, outputs: [{ label: "default" }] },
    schema: [
      {
        key: "mode",
        label: "Mode",
        type: "select",
        options: [
          { label: "Element", value: "element" },
          { label: "Offset", value: "offset" },
          { label: "Container", value: "container" },
        ] as any,
        default: "offset",
      },
      {
        key: "target",
        label: "Target (for element/container)",
        type: "json",
        widget: "targetlocator",
      },
      {
        key: "offset",
        label: "Offset",
        type: "object",
        fields: [
          { key: "x", label: "X", type: "number" },
          { key: "y", label: "Y", type: "number" },
        ],
      },
    ],
    defaults: { mode: "offset", offset: { x: 0, y: 300 } },
  });

  // Drag
  registerNodeSpec({
    type: STEP_TYPES.DRAG,
    version: 1,
    display: { label: "Drag", iconClass: "icon-drag", category: "Actions" },
    ports: { inputs: 1, outputs: [{ label: "default" }] },
    schema: [
      { key: "start", label: "Start", type: "json", widget: "targetlocator" },
      { key: "end", label: "End", type: "json", widget: "targetlocator" },
      {
        key: "path",
        label: "Path Coordinates",
        type: "array",
        item: {
          key: "p",
          label: "Point",
          type: "object",
          fields: [
            { key: "x", label: "X", type: "number" },
            { key: "y", label: "Y", type: "number" },
          ],
        } as any,
      },
    ],
    defaults: {},
  });

  // Wait
  registerNodeSpec({
    type: STEP_TYPES.WAIT,
    version: 1,
    display: { label: "Wait", iconClass: "icon-wait", category: "Actions" },
    ports: { inputs: 1, outputs: [{ label: "default" }] },
    schema: [
      {
        key: "condition",
        label: "Condition (JSON)",
        type: "json",
        help: 'e.g. {"sleep":1000} or {"text":"Hello","appear":true}',
      },
    ],
    defaults: { condition: { sleep: 500 } },
  });

  // Assert
  registerNodeSpec({
    type: STEP_TYPES.ASSERT,
    version: 1,
    display: { label: "Assert", iconClass: "icon-assert", category: "Actions" },
    ports: { inputs: 1, outputs: [{ label: "default" }, { label: "onError" }] },
    schema: [
      {
        key: "assert",
        label: "Assert (JSON)",
        type: "json",
        help: 'e.g. {"exists":"#id"} / {"visible":".btn"}',
      },
      {
        key: "failStrategy",
        label: "Fail Strategy",
        type: "select",
        options: [
          { label: "Stop", value: "stop" },
          { label: "Warn", value: "warn" },
          { label: "Retry", value: "retry" },
        ] as any,
        default: "stop",
      },
    ],
    defaults: { assert: {} },
  });

  // HTTP
  registerNodeSpec({
    type: STEP_TYPES.HTTP,
    version: 1,
    display: { label: "HTTP", iconClass: "icon-http", category: "Tools" },
    ports: { inputs: 1, outputs: [{ label: "default" }] },
    schema: [
      {
        key: "method",
        label: "Method",
        type: "select",
        options: ["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => ({
          label: m,
          value: m,
        })) as any,
        default: "GET",
      },
      { key: "url", label: "URL", type: "string", required: true },
      { key: "headers", label: "Headers (JSON)", type: "json" },
      { key: "body", label: "Body (JSON)", type: "json" },
      { key: "formData", label: "Form Data (JSON)", type: "json" },
      { key: "saveAs", label: "Save As Variable", type: "string" },
      { key: "assign", label: "Mapping (JSON)", type: "json" },
    ],
    defaults: { method: "GET" },
  });

  // Extract
  registerNodeSpec({
    type: STEP_TYPES.EXTRACT,
    version: 1,
    display: { label: "Extract", iconClass: "icon-extract", category: "Tools" },
    ports: { inputs: 1, outputs: [{ label: "default" }] },
    schema: [
      {
        key: "selector",
        label: "Selector",
        type: "string",
        widget: "selector",
      },
      {
        key: "attr",
        label: "Attribute",
        type: "select",
        options: [
          { label: "Text (text)", value: "text" },
          { label: "Text (textContent)", value: "textContent" },
          { label: "Custom Attribute", value: "attr" },
        ] as any,
      },
      {
        key: "js",
        label: "Custom JS",
        type: "string",
        help: "Execute in page and return value",
      },
      { key: "saveAs", label: "Save Variable", type: "string", required: true },
    ],
    defaults: { saveAs: "" },
  });

  // Screenshot
  registerNodeSpec({
    type: STEP_TYPES.SCREENSHOT,
    version: 1,
    display: {
      label: "Screenshot",
      iconClass: "icon-screenshot",
      category: "Tools",
    },
    ports: { inputs: 1, outputs: [{ label: "default" }] },
    schema: [
      { key: "selector", label: "Target Selector", type: "string" },
      {
        key: "fullPage",
        label: "Full Page Screenshot",
        type: "boolean",
        default: false,
      },
      {
        key: "background",
        label: "Background",
        type: "boolean",
      },
      { key: "saveAs", label: "Save Variable", type: "string" },
    ],
    defaults: { fullPage: false },
  });

  // TriggerEvent
  registerNodeSpec({
    type: STEP_TYPES.TRIGGER_EVENT,
    version: 1,
    display: {
      label: "Trigger Event",
      iconClass: "icon-trigger",
      category: "Tools",
    },
    ports: { inputs: 1, outputs: [{ label: "default" }] },
    schema: [
      { key: "target", label: "Target", type: "json", widget: "targetlocator" },
      { key: "event", label: "Event Type", type: "string", required: true },
      { key: "bubbles", label: "Bubbles", type: "boolean", default: true },
      {
        key: "cancelable",
        label: "Cancelable",
        type: "boolean",
        default: false,
      },
    ],
    defaults: { event: "" },
  });

  // SetAttribute
  registerNodeSpec({
    type: STEP_TYPES.SET_ATTRIBUTE,
    version: 1,
    display: {
      label: "Set Attribute",
      iconClass: "icon-attr",
      category: "Tools",
    },
    ports: { inputs: 1, outputs: [{ label: "default" }] },
    schema: [
      { key: "target", label: "Target", type: "json", widget: "targetlocator" },
      { key: "name", label: "Attribute Name", type: "string", required: true },
      { key: "value", label: "Attribute Value", type: "string" },
      {
        key: "remove",
        label: "Remove Attribute",
        type: "boolean",
        default: false,
      },
    ],
    defaults: { remove: false },
  });

  // LoopElements
  registerNodeSpec({
    type: STEP_TYPES.LOOP_ELEMENTS,
    version: 1,
    display: {
      label: "Loop Elements",
      iconClass: "icon-loop",
      category: "Tools",
    },
    ports: { inputs: 1, outputs: [{ label: "default" }] },
    schema: [
      { key: "selector", label: "Selector", type: "string", required: true },
      {
        key: "saveAs",
        label: "List Variable Name",
        type: "string",
        default: "elements",
      },
      {
        key: "itemVar",
        label: "Item Variable Name",
        type: "string",
        default: "item",
      },
      { key: "subflowId", label: "Subflow ID", type: "string", required: true },
    ],
    defaults: { saveAs: "elements", itemVar: "item" },
  });

  // SwitchFrame
  registerNodeSpec({
    type: STEP_TYPES.SWITCH_FRAME,
    version: 1,
    display: {
      label: "Switch Frame",
      iconClass: "icon-frame",
      category: "Tools",
    },
    ports: { inputs: 1, outputs: [{ label: "default" }] },
    schema: [
      {
        key: "frame",
        label: "Frame Locator",
        type: "object",
        fields: [
          { key: "index", label: "Index", type: "number" },
          { key: "urlContains", label: "URL Contains", type: "string" },
        ],
      },
    ],
    defaults: {},
  });

  // HandleDownload
  registerNodeSpec({
    type: STEP_TYPES.HANDLE_DOWNLOAD,
    version: 1,
    display: {
      label: "Handle Download",
      iconClass: "icon-download",
      category: "Tools",
    },
    ports: { inputs: 1, outputs: [{ label: "default" }] },
    schema: [
      { key: "filenameContains", label: "Filename Contains", type: "string" },
      {
        key: "waitForComplete",
        label: "Wait For Complete",
        type: "boolean",
        default: true,
      },
      {
        key: "timeoutMs",
        label: "Timeout (ms)",
        type: "number",
        default: 60000,
      },
      { key: "saveAs", label: "Save Variable", type: "string" },
    ],
    defaults: { waitForComplete: true, timeoutMs: 60000 },
  });

  // Script
  registerNodeSpec({
    type: STEP_TYPES.SCRIPT,
    version: 1,
    display: { label: "Script", iconClass: "icon-script", category: "Tools" },
    ports: { inputs: 1, outputs: [{ label: "default" }] },
    schema: [
      {
        key: "world",
        label: "Execution Context",
        type: "select",
        options: [
          { label: "ISOLATED", value: "ISOLATED" },
          { label: "MAIN", value: "MAIN" },
        ] as any,
        default: "ISOLATED",
      },
      {
        key: "code",
        label: "Script Code",
        type: "string",
        widget: "code",
        required: true,
      },
      {
        key: "when",
        label: "Execution Timing",
        type: "select",
        options: [
          { label: "before", value: "before" },
          { label: "after", value: "after" },
        ] as any,
        default: "after",
      },
      { key: "assign", label: "Mapping (JSON)", type: "json" },
      { key: "saveAs", label: "Save Variable", type: "string" },
    ],
    defaults: { world: "ISOLATED", when: "after" },
  });

  // Tabs
  registerNodeSpec({
    type: STEP_TYPES.OPEN_TAB,
    version: 1,
    display: { label: "Open Tab", iconClass: "icon-openTab", category: "Tabs" },
    ports: { inputs: 1, outputs: [{ label: "default" }] },
    schema: [
      { key: "url", label: "URL", type: "string" },
      {
        key: "newWindow",
        label: "New Window",
        type: "boolean",
        default: false,
      },
      {
        key: "background",
        label: "Background",
        type: "boolean",
      },
    ],
    defaults: { newWindow: false },
  });
  registerNodeSpec({
    type: "executeFlow" as any,
    version: 1,
    display: {
      label: "Execute Subflow",
      iconClass: "icon-exec",
      category: "Flow",
    },
    ports: { inputs: 1, outputs: [{ label: "default" }] },
    schema: [
      { key: "flowId", label: "Flow ID", type: "string", required: true },
      {
        key: "inline",
        label: "Inline Execution",
        type: "boolean",
        default: false,
      },
      { key: "args", label: "Args (JSON)", type: "json" },
    ],
    defaults: { inline: false },
  });
  registerNodeSpec({
    type: STEP_TYPES.SWITCH_TAB,
    version: 1,
    display: {
      label: "Switch Tab",
      iconClass: "icon-switchTab",
      category: "Tabs",
    },
    ports: { inputs: 1, outputs: [{ label: "default" }] },
    schema: [
      { key: "tabId", label: "TabId", type: "number" },
      { key: "urlContains", label: "URL Contains", type: "string" },
      { key: "titleContains", label: "Title Contains", type: "string" },
      {
        key: "background",
        label: "Background",
        type: "boolean",
      },
    ],
    defaults: {},
  });
  registerNodeSpec({
    type: STEP_TYPES.CLOSE_TAB,
    version: 1,
    display: {
      label: "Close Tab",
      iconClass: "icon-closeTab",
      category: "Tabs",
    },
    ports: { inputs: 1, outputs: [{ label: "default" }] },
    schema: [
      {
        key: "tabIds",
        label: "TabIds",
        type: "array",
        item: { key: "id", label: "id", type: "number" } as any,
      },
      { key: "url", label: "URL", type: "string" },
    ],
    defaults: {},
  });

  // Logic
  registerNodeSpec({
    type: STEP_TYPES.IF,
    version: 1,
    display: { label: "Condition", iconClass: "icon-if", category: "Logic" },
    ports: { inputs: 1, outputs: "any" },
    schema: [
      {
        key: "condition",
        label: "Condition Expression (JSON)",
        type: "json",
        help: 'e.g. {"expression":"vars.a>0"} etc.',
      },
      {
        key: "branches",
        label: "Branches",
        type: "array",
        item: {
          key: "b",
          label: "case",
          type: "object",
          fields: [
            { key: "id", label: "ID", type: "string" },
            { key: "name", label: "Name", type: "string" },
            { key: "expr", label: "Expression", type: "string" },
          ],
        } as any,
      },
      { key: "else", label: "Enable else", type: "boolean", default: true },
    ],
    defaults: { else: true },
  });
  registerNodeSpec({
    type: STEP_TYPES.FOREACH,
    version: 1,
    display: { label: "Loop", iconClass: "icon-foreach", category: "Logic" },
    ports: { inputs: 1, outputs: [{ label: "default" }] },
    schema: [
      {
        key: "listVar",
        label: "List Variable",
        type: "string",
        required: true,
      },
      {
        key: "itemVar",
        label: "Item Variable",
        type: "string",
        default: "item",
      },
      { key: "subflowId", label: "Subflow ID", type: "string", required: true },
      {
        key: "concurrency",
        label: "Concurrency",
        type: "number",
        default: 1,
        help: "Execute subflows concurrently (shallow copy variables, no auto-merge)",
      },
    ],
    defaults: { itemVar: "item" },
  });
  registerNodeSpec({
    type: STEP_TYPES.WHILE,
    version: 1,
    display: { label: "Loop", iconClass: "icon-while", category: "Logic" },
    ports: { inputs: 1, outputs: [{ label: "default" }] },
    schema: [
      { key: "condition", label: "Condition (JSON)", type: "json" },
      { key: "subflowId", label: "Subflow ID", type: "string", required: true },
      {
        key: "maxIterations",
        label: "Max Iterations",
        type: "number",
        default: 100,
      },
    ],
    defaults: { maxIterations: 100 },
  });

  // Delay (UI-only helper)
  registerNodeSpec({
    type: STEP_TYPES.DELAY,
    version: 1,
    display: { label: "Delay", iconClass: "icon-delay", category: "Actions" },
    ports: { inputs: 1, outputs: [{ label: "default" }] },
    schema: [
      {
        key: "sleep",
        label: "Delay",
        type: "number",
        widget: "duration",
        required: true,
        default: 1000,
      },
    ],
    defaults: { sleep: 1000 },
  });

  // Trigger (builder-only, flow-level node)
  registerNodeSpec({
    type: STEP_TYPES.TRIGGER,
    version: 1,
    display: { label: "Trigger", iconClass: "icon-trigger", category: "Flow" },
    ports: { inputs: 0, outputs: [{ label: "default" }] },
    schema: [
      { key: "enabled", label: "Enabled", type: "boolean", default: true },
      { key: "description", label: "Description", type: "string" },
      {
        key: "modes",
        label: "Modes",
        type: "object",
        fields: [
          { key: "manual", label: "Manual", type: "boolean", default: true },
          { key: "url", label: "URL Trigger", type: "boolean", default: false },
          {
            key: "contextMenu",
            label: "Context Menu",
            type: "boolean",
            default: false,
          },
          {
            key: "command",
            label: "Shortcut",
            type: "boolean",
            default: false,
          },
          { key: "dom", label: "DOM Event", type: "boolean", default: false },
          {
            key: "schedule",
            label: "Schedule",
            type: "boolean",
            default: false,
          },
        ],
      },
      {
        key: "url",
        label: "URL Rules",
        type: "object",
        fields: [
          {
            key: "rules",
            label: "Rule List",
            type: "array",
            item: {
              key: "rule",
              label: "Rule",
              type: "object",
              fields: [
                {
                  key: "kind",
                  label: "Type",
                  type: "select",
                  options: [
                    { label: "URL", value: "url" },
                    { label: "Domain", value: "domain" },
                    { label: "Path", value: "path" },
                  ] as any,
                  default: "url",
                },
                { key: "value", label: "Value", type: "string" },
              ],
            } as any,
          },
        ],
      },
      {
        key: "contextMenu",
        label: "Context Menu",
        type: "object",
        fields: [
          {
            key: "title",
            label: "Title",
            type: "string",
            default: "Run Workflow",
          },
          { key: "enabled", label: "Enabled", type: "boolean", default: false },
        ],
      },
      {
        key: "command",
        label: "Shortcut",
        type: "object",
        fields: [
          { key: "commandKey", label: "Shortcut Key", type: "string" },
          { key: "enabled", label: "Enabled", type: "boolean", default: false },
        ],
      },
      {
        key: "dom",
        label: "DOM Event",
        type: "object",
        fields: [
          { key: "selector", label: "Selector", type: "string" },
          { key: "appear", label: "Appear", type: "boolean", default: true },
          { key: "once", label: "Once", type: "boolean", default: true },
          {
            key: "debounceMs",
            label: "Debounce (ms)",
            type: "number",
            default: 800,
          },
          { key: "enabled", label: "Enabled", type: "boolean", default: false },
        ],
      },
      {
        key: "schedules",
        label: "Schedules",
        type: "array",
        item: {
          key: "sched",
          label: "Schedule",
          type: "object",
          fields: [
            { key: "id", label: "ID", type: "string" },
            {
              key: "type",
              label: "Type",
              type: "select",
              options: [
                { label: "Once", value: "once" },
                { label: "Interval", value: "interval" },
                { label: "Daily", value: "daily" },
              ] as any,
            },
            { key: "when", label: "Time (ISO)", type: "string" },
            {
              key: "enabled",
              label: "Enabled",
              type: "boolean",
              default: true,
            },
          ],
        } as any,
      },
    ],
    defaults: { enabled: true },
  });
}
