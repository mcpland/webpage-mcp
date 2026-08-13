# Third-Party Notices — MCP Server npm Package

This table is a human-readable summary of the `webpage-mcp` package's direct runtime dependencies and reviewed bundled protocol components. `THIRD_PARTY_COMPONENTS.json` combines the exact `npm-shrinkwrap.json` runtime closure with the dependency versions proven by the server bundle metafile, including transitive, peer, optional, and cross-platform packages. npm installs the runtime closure as separate packages; the MCP SDK and its used HTTP-transport and schema-validation modules are compiled into selected entry points. Listing a build or install input does not imply that all of its code is bundled, and does not alter its upstream terms.

License identifiers in this table are the upstream package declarations. `THIRD_PARTY_COMPONENTS.json` records both the declared and reviewed concluded license, the lockfile integrity, and SHA-256 hashes of the package-root license evidence used for review. Neither file is a substitute for the upstream license texts installed with each separate dependency; the Source column points to the corresponding projects and license materials. The Anthropic SDK is not classified as open source: its package explicitly declares `SEE LICENSE IN README.md` and points users to Anthropic's legal agreements.

| Ecosystem | Component                        | Version       | License                    | Distribution                             | Source                                                    |
| --------- | -------------------------------- | ------------- | -------------------------- | ---------------------------------------- | --------------------------------------------------------- |
| npm       | `@anthropic-ai/claude-agent-sdk` | `0.3.231`     | `SEE LICENSE IN README.md` | Runtime dependency under Anthropic terms | https://github.com/anthropics/claude-agent-sdk-typescript |
| npm       | `@anthropic-ai/sdk`              | `0.116.0`     | `MIT`                      | Runtime peer dependency                  | https://github.com/anthropics/anthropic-sdk-typescript    |
| npm       | `@hono/node-server`              | `2.0.10`      | `MIT`                      | Bundled SDK HTTP adapter code            | https://github.com/honojs/node-server                     |
| npm       | `@modelcontextprotocol/sdk`      | `1.29.0`      | `MIT`                      | Runtime peer and bundled protocol code   | https://github.com/modelcontextprotocol/typescript-sdk    |
| npm       | `better-sqlite3`                 | `12.11.1`     | `MIT`                      | Runtime dependency with native binary    | https://github.com/WiseLibs/better-sqlite3                |
| npm       | `chalk`                          | `5.6.2`       | `MIT`                      | Declared runtime dependency              | https://github.com/chalk/chalk                            |
| npm       | `chrome-devtools-frontend`       | `1.0.1587905` | `BSD-3-Clause`             | Runtime trace-analysis dependency        | https://github.com/ChromeDevTools/devtools-frontend       |
| npm       | `commander`                      | `13.1.0`      | `MIT`                      | Runtime CLI dependency                   | https://github.com/tj/commander.js                        |
| npm       | `cross-spawn`                    | `7.0.6`       | `MIT`                      | Runtime process-launch dependency        | https://github.com/moxystudio/node-cross-spawn            |
| npm       | `drizzle-orm`                    | `0.45.2`      | `Apache-2.0`               | Runtime database dependency              | https://github.com/drizzle-team/drizzle-orm               |
| npm       | `hono`                           | `4.12.34`     | `MIT`                      | Bundled SDK HTTP routing code            | https://github.com/honojs/hono                            |
| npm       | `is-admin`                       | `4.0.0`       | `MIT`                      | Runtime Windows privilege helper         | https://github.com/sindresorhus/is-admin                  |
| npm       | `pino`                           | `9.14.0`      | `MIT`                      | Declared runtime dependency              | https://github.com/pinojs/pino                            |
| npm       | `uuid`                           | `11.1.1`      | `MIT`                      | Runtime identifier dependency            | https://github.com/uuidjs/uuid                            |
| npm       | `zod`                            | `4.4.3`       | `MIT`                      | Runtime schema dependency                | https://github.com/colinhacks/zod                         |

For `@anthropic-ai/claude-agent-sdk` and its platform packages, consult the exact `LICENSE.md` and README distributed with the installed packages before use. No rights beyond their upstream terms are granted by this notice.
