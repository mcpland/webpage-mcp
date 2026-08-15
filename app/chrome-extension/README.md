# WXT + React

This extension uses WXT with React-based entrypoints.

The native bridge is local, but Agent providers, model downloads, and browser
network tools can create external data flows. Review the repository
[privacy and data-flow boundaries](../../README.md#privacy-and-data-flows)
before enabling the extension on sensitive pages.

## Browser requirements

The Webpage MCP Connector as a whole requires Google Chrome 135 or newer. The
generated extension manifest enforces this minimum, so the Connector cannot be
installed on an older Chrome release.

The user-script manager and privileged Web Editor runtime also require a
Chrome-controlled opt-in. In Chrome
135–137, enable **Developer mode** on `chrome://extensions`. In Chrome 138 or
newer, open the Connector's Details page and enable **Allow User Scripts**.
These toggles do not lower the Connector's Chrome 135 minimum.

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/)
- TypeScript and ESLint extensions
