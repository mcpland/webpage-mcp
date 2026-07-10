# Third-Party Notices — MCP Server npm Package

This reviewed inventory covers every production dependency declared by the `webpage-mcp` npm package. npm installs these components as separate packages; the server bundles only first-party `webpage-mcp-shared` code into selected entry points. Listing a dependency here does not alter its upstream terms.

License identifiers below are the upstream package declarations. This file intentionally does not duplicate each license's full text; the Source column points to the corresponding upstream project and license materials. The Anthropic SDK is not classified as an open-source license: its package explicitly declares `SEE LICENSE IN README.md` and points users to Anthropic's legal agreements.

| Ecosystem | Component                        | Version       | License                    | Distribution                             | Source                                                    |
| --------- | -------------------------------- | ------------- | -------------------------- | ---------------------------------------- | --------------------------------------------------------- |
| npm       | `@anthropic-ai/claude-agent-sdk` | `0.1.77`      | `SEE LICENSE IN README.md` | Runtime dependency under Anthropic terms | https://github.com/anthropics/claude-agent-sdk-typescript |
| npm       | `@modelcontextprotocol/sdk`      | `1.29.0`      | `MIT`                      | Runtime dependency                       | https://github.com/modelcontextprotocol/typescript-sdk    |
| npm       | `better-sqlite3`                 | `12.11.1`     | `MIT`                      | Runtime dependency with native binary    | https://github.com/WiseLibs/better-sqlite3                |
| npm       | `chalk`                          | `5.6.2`       | `MIT`                      | Declared runtime dependency              | https://github.com/chalk/chalk                            |
| npm       | `chrome-devtools-frontend`       | `1.0.1587905` | `BSD-3-Clause`             | Runtime trace-analysis dependency        | https://github.com/ChromeDevTools/devtools-frontend       |
| npm       | `commander`                      | `13.1.0`      | `MIT`                      | Runtime CLI dependency                   | https://github.com/tj/commander.js                        |
| npm       | `cross-spawn`                    | `7.0.6`       | `MIT`                      | Runtime process-launch dependency        | https://github.com/moxystudio/node-cross-spawn            |
| npm       | `drizzle-orm`                    | `0.45.2`      | `Apache-2.0`               | Runtime database dependency              | https://github.com/drizzle-team/drizzle-orm               |
| npm       | `is-admin`                       | `4.0.0`       | `MIT`                      | Runtime Windows privilege helper         | https://github.com/sindresorhus/is-admin                  |
| npm       | `pino`                           | `9.14.0`      | `MIT`                      | Declared runtime dependency              | https://github.com/pinojs/pino                            |
| npm       | `uuid`                           | `11.1.1`      | `MIT`                      | Runtime identifier dependency            | https://github.com/uuidjs/uuid                            |

For `@anthropic-ai/claude-agent-sdk`, consult the exact `LICENSE.md` and README distributed with that installed package before use. No rights beyond its upstream terms are granted by this notice.
