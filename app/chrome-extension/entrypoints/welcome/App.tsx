import { useState } from "react";
import { LINKS, NATIVE_HOST } from "@/common/constants";

import "../sidepanel/styles/agent-chat.css";
import "./App.css";

const COMMANDS = {
  npmInstall: "npm install -g webpage-mcp",
  pnpmInstall: "pnpm add -g webpage-mcp",
  yarnInstall: "yarn global add webpage-mcp",
  mcpUrl: `http://127.0.0.1:${NATIVE_HOST.DEFAULT_PORT}/mcp`,
  doctor: "webpage-mcp doctor",
  fix: "webpage-mcp doctor --fix",
  report: "webpage-mcp report --copy",
} as const;

type CommandKey = keyof typeof COMMANDS;

const ALT_INSTALL = [
  { label: "pnpm", key: "pnpmInstall" },
  { label: "yarn", key: "yarnInstall" },
] as const satisfies ReadonlyArray<{ label: string; key: CommandKey }>;

const DIAGNOSTICS = [
  { label: "Doctor", key: "doctor" },
  { label: "Auto-fix", key: "fix" },
] as const satisfies ReadonlyArray<{ label: string; key: CommandKey }>;

function copyLabel(copiedKey: CommandKey | null, key: CommandKey): string {
  return copiedKey === key ? "Copied" : "Copy";
}

function copyColor(copiedKey: CommandKey | null, key: CommandKey): string {
  return copiedKey === key ? "var(--ac-success)" : "var(--ac-text-muted)";
}

export default function WelcomeApp() {
  const [copiedKey, setCopiedKey] = useState<CommandKey | null>(null);

  const copyCommand = async (key: CommandKey): Promise<void> => {
    try {
      await navigator.clipboard.writeText(COMMANDS[key]);
      setCopiedKey(key);
      window.setTimeout(() => {
        setCopiedKey((current) => (current === key ? null : current));
      }, 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
      setCopiedKey(null);
    }
  };

  const openDocs = async (): Promise<void> => {
    try {
      await chrome.tabs.create({ url: LINKS.TROUBLESHOOTING });
    } catch {
      window.open(LINKS.TROUBLESHOOTING, "_blank", "noopener,noreferrer");
    }
  };

  return (
    <div className="agent-theme welcome-root">
      <div className="min-h-screen flex flex-col">
        <header className="welcome-header flex-none px-6 py-5">
          <div className="max-w-3xl mx-auto flex items-center justify-between gap-4">
            <div className="flex items-center gap-3 min-w-0">
              <div
                className="welcome-icon w-10 h-10 flex items-center justify-center flex-shrink-0"
                aria-hidden="true"
              >
                <svg
                  className="w-6 h-6"
                  style={{ color: "var(--ac-accent)" }}
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                    d="M13 10V3L4 14h7v7l9-11h-7z"
                  />
                </svg>
              </div>
              <div className="min-w-0">
                <h1 className="welcome-title text-lg font-medium tracking-tight truncate">
                  Webpage MCP Server
                </h1>
                <p className="welcome-muted text-sm truncate">
                  After the extension is installed, this is the only required step.
                </p>
              </div>
            </div>

            <button
              type="button"
              className="welcome-button px-3 py-2 text-xs font-medium ac-btn flex-shrink-0"
              onClick={() => void openDocs()}
            >
              Troubleshooting Docs
            </button>
          </div>
        </header>

        <main className="flex-1 px-6 py-8">
          <div className="max-w-3xl mx-auto space-y-6">
            <section className="welcome-card welcome-card--primary p-6">
              <h2 className="welcome-title text-xl font-medium">
                Install <code className="welcome-code">webpage-mcp</code>
              </h2>
              <p className="welcome-muted text-sm mt-2">
                The Chrome extension uses this local bridge to expose MCP tools to your client.
              </p>

              <div className="mt-4 space-y-3">
                <div className="welcome-command-row flex items-center justify-between gap-3 px-4 py-3">
                  <code className="welcome-code text-sm break-all">{COMMANDS.npmInstall}</code>
                  <button
                    type="button"
                    className="welcome-mono px-2 py-1 text-xs font-medium ac-btn flex-shrink-0"
                    style={{ color: copyColor(copiedKey, "npmInstall") }}
                    onClick={() => void copyCommand("npmInstall")}
                  >
                    {copyLabel(copiedKey, "npmInstall")}
                  </button>
                </div>

                <div className="grid sm:grid-cols-2 gap-3">
                  {ALT_INSTALL.map((item) => (
                    <div
                      key={item.key}
                      className="welcome-alt-row flex items-center justify-between gap-3 px-4 py-3"
                    >
                      <div className="min-w-0">
                        <div className="welcome-mono welcome-subtle text-[10px] uppercase tracking-widest font-medium">
                          {item.label}
                        </div>
                        <code className="welcome-code text-xs break-all">{COMMANDS[item.key]}</code>
                      </div>
                      <button
                        type="button"
                        className="welcome-mono px-2 py-1 text-xs font-medium ac-btn flex-shrink-0"
                        style={{ color: copyColor(copiedKey, item.key) }}
                        onClick={() => void copyCommand(item.key)}
                      >
                        {copyLabel(copiedKey, item.key)}
                      </button>
                    </div>
                  ))}
                </div>

                <div className="welcome-alt-row welcome-muted px-4 py-3 text-xs">
                  Requires Node.js 20+. Check your version with{" "}
                  <code className="welcome-code welcome-code-inline px-1 py-0.5">node -v</code>.
                </div>
              </div>

              <div
                className="mt-6 pt-5"
                style={{ borderTop: "var(--ac-border-width) solid var(--ac-border)" }}
              >
                <h3 className="welcome-title text-sm font-medium">MCP client URL (streamable HTTP)</h3>
                <p className="welcome-muted text-sm mt-1">
                  Use this URL in your MCP client (e.g., Claude Desktop, CherryStudio).
                </p>

                <div className="welcome-command-row mt-3 flex items-center justify-between gap-3 px-4 py-3">
                  <code className="welcome-code text-sm break-all">{COMMANDS.mcpUrl}</code>
                  <button
                    type="button"
                    className="welcome-mono px-2 py-1 text-xs font-medium ac-btn flex-shrink-0"
                    style={{ color: copyColor(copiedKey, "mcpUrl") }}
                    onClick={() => void copyCommand("mcpUrl")}
                  >
                    {copyLabel(copiedKey, "mcpUrl")}
                  </button>
                </div>

                <p className="welcome-subtle text-xs mt-3">
                  Tip: You can also open the extension popup and click &quot;Connect&quot; to copy a
                  full client config snippet.
                </p>
              </div>
            </section>

            <details className="welcome-card overflow-hidden">
              <summary className="px-6 py-4 cursor-pointer select-none flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <div className="welcome-title text-sm font-medium">Troubleshooting</div>
                  <div className="welcome-muted text-xs truncate">
                    Use these only if the bridge fails to register or connect.
                  </div>
                </div>
                <span className="welcome-mono welcome-subtle text-xs flex-shrink-0">
                  doctor | report
                </span>
              </summary>

              <div className="px-6 pb-6 space-y-4">
                <div className="welcome-alt-row p-4">
                  <div className="text-sm font-medium">Diagnostics</div>
                  <p className="welcome-muted text-sm mt-1">
                    Run <code className="welcome-code">doctor</code> to check installation status. If it
                    reports an error, run the auto-fix command.
                  </p>

                  <div className="mt-3 space-y-2">
                    {DIAGNOSTICS.map((item) => (
                      <div
                        key={item.key}
                        className="welcome-command-row flex items-center justify-between gap-3 px-3 py-2"
                      >
                        <div className="min-w-0">
                          <div className="welcome-mono welcome-subtle text-[10px] uppercase tracking-widest font-medium">
                            {item.label}
                          </div>
                          <code className="welcome-code text-xs break-all">{COMMANDS[item.key]}</code>
                        </div>
                        <button
                          type="button"
                          className="welcome-mono px-2 py-1 text-xs font-medium ac-btn flex-shrink-0"
                          style={{ color: copyColor(copiedKey, item.key) }}
                          onClick={() => void copyCommand(item.key)}
                        >
                          {copyLabel(copiedKey, item.key)}
                        </button>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="welcome-report-card p-4">
                  <div className="text-sm font-medium" style={{ color: "var(--ac-danger)" }}>
                    Report an issue
                  </div>
                  <p className="welcome-muted text-sm mt-1">
                    Generate a diagnostic report and paste it into a GitHub issue.
                  </p>

                  <div className="welcome-command-row mt-3 flex items-center justify-between gap-3 px-3 py-2">
                    <code className="welcome-code text-xs break-all">{COMMANDS.report}</code>
                    <button
                      type="button"
                      className="welcome-mono px-2 py-1 text-xs font-medium ac-btn flex-shrink-0"
                      style={{ color: copyColor(copiedKey, "report") }}
                      onClick={() => void copyCommand("report")}
                    >
                      {copyLabel(copiedKey, "report")}
                    </button>
                  </div>

                  <p className="welcome-subtle text-xs mt-2">
                    This copies the report to your clipboard (sensitive info is automatically
                    redacted).
                  </p>
                </div>

                <div className="flex">
                  <button
                    type="button"
                    className="welcome-button px-3 py-2 text-xs font-medium ac-btn"
                    onClick={() => void openDocs()}
                  >
                    Open troubleshooting docs
                  </button>
                </div>
              </div>
            </details>
          </div>
        </main>
      </div>
    </div>
  );
}
