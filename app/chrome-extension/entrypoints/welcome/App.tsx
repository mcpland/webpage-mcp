import { useMemo, useState } from "react";
import { LINKS } from "@/common/constants";
import { getMessage } from "@/utils/i18n";

import "../sidepanel/styles/agent-chat.css";
import "./App.css";

const STATIC_COMMANDS = {
  stdioCommand: "npx -y -p webpage-mcp@latest webpage-mcp-stdio",
  mcpConfig: `{
  "mcpServers": {
    "webpage-mcp": {
      "command": "npx",
      "args": ["-y", "-p", "webpage-mcp@latest", "webpage-mcp-stdio"]
    }
  }
}`,
  doctor: "npx -y webpage-mcp@latest doctor",
  fix: "npx -y webpage-mcp@latest doctor --fix",
  report: "npx -y webpage-mcp@latest report --copy",
} as const;

type StaticCommandKey = keyof typeof STATIC_COMMANDS;
type CommandKey = StaticCommandKey | "register";

const DIAGNOSTICS = [
  { labelKey: "welcomeDoctorLabel", fallback: "Doctor", key: "doctor" },
  { labelKey: "welcomeAutoFixLabel", fallback: "Auto-fix", key: "fix" },
] as const satisfies ReadonlyArray<{ labelKey: string; fallback: string; key: CommandKey }>;

function copyColor(copiedKey: CommandKey | null, key: CommandKey): string {
  return copiedKey === key ? "var(--ac-success)" : "var(--ac-text-muted)";
}

export default function WelcomeApp() {
  const t = (key: string, fallback: string, substitutions?: string[]) =>
    getMessage(key, substitutions, fallback);

  const [copiedKey, setCopiedKey] = useState<CommandKey | null>(null);
  const extensionId = chrome.runtime?.id || "<your_extension_id>";
  const registerCommand = useMemo(
    () =>
      `npx -y webpage-mcp@latest register --browser chrome --force --extension-id ${extensionId}`,
    [extensionId],
  );
  const commands = useMemo(
    () => ({
      ...STATIC_COMMANDS,
      register: registerCommand,
    }),
    [registerCommand],
  );
  const copyLabel = (key: CommandKey): string =>
    copiedKey === key ? t("popupCopiedShort", "Copied") : t("welcomeCopyButton", "Copy");

  const copyCommand = async (key: CommandKey): Promise<void> => {
    try {
      await navigator.clipboard.writeText(commands[key]);
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
                  {t("welcomeHeaderTitle", "Webpage MCP Connector")}
                </h1>
                <p className="welcome-muted text-sm truncate">
                  {t(
                    "welcomeHeaderSubtitle",
                    "Extension-aware setup commands (includes this extension ID).",
                  )}
                </p>
              </div>
            </div>

            <button
              type="button"
              className="welcome-button px-3 py-2 text-xs font-medium ac-btn flex-shrink-0"
              onClick={() => void openDocs()}
            >
              {t("welcomeTroubleshootingDocsButton", "Troubleshooting Docs")}
            </button>
          </div>
        </header>

        <main className="flex-1 px-6 py-8">
          <div className="max-w-3xl mx-auto space-y-6">
            <section className="welcome-card welcome-card--primary p-6">
              <h2 className="welcome-title text-xl font-medium">
                {t("welcomeRegisterHostTitle", "Register Native Host (one-time)")}
              </h2>
              <p className="welcome-muted text-sm mt-2">
                {t(
                  "welcomeRegisterHostDesc",
                  "Run this command first. It writes the Native Messaging manifest with your current extension ID so Chrome can launch the local host process.",
                )}
              </p>

              <div className="mt-4 space-y-3">
                <div className="welcome-command-row flex items-center justify-between gap-3 px-4 py-3">
                  <code className="welcome-code text-sm break-all">{commands.register}</code>
                  <button
                    type="button"
                    className="welcome-mono px-2 py-1 text-xs font-medium ac-btn flex-shrink-0"
                    style={{ color: copyColor(copiedKey, "register") }}
                    onClick={() => void copyCommand("register")}
                  >
                    {copyLabel("register")}
                  </button>
                </div>

                <div className="welcome-alt-row welcome-muted px-4 py-3 text-xs">
                  {t("welcomeCurrentExtensionId", "Current extension ID:")}{" "}
                  <code className="welcome-code welcome-code-inline px-1 py-0.5">{extensionId}</code>
                </div>
              </div>

              <div
                className="mt-6 pt-5"
                style={{ borderTop: "var(--ac-border-width) solid var(--ac-border)" }}
              >
                <h3 className="welcome-title text-sm font-medium">
                  {t("welcomeStdioCommandTitle", "MCP stdio command")}
                </h3>
                <p className="welcome-muted text-sm mt-1">
                  {t(
                    "welcomeStdioCommandDesc",
                    "Then use this command in your MCP client. No global install and no localhost URL are required.",
                  )}
                </p>

                <div className="welcome-command-row mt-3 flex items-center justify-between gap-3 px-4 py-3">
                  <code className="welcome-code text-sm break-all">{commands.stdioCommand}</code>
                  <button
                    type="button"
                    className="welcome-mono px-2 py-1 text-xs font-medium ac-btn flex-shrink-0"
                    style={{ color: copyColor(copiedKey, "stdioCommand") }}
                    onClick={() => void copyCommand("stdioCommand")}
                  >
                    {copyLabel("stdioCommand")}
                  </button>
                </div>

                <h3 className="welcome-title text-sm font-medium">
                  {t("welcomeMcpConfigTitle", "MCP client config (stdio)")}
                </h3>
                <p className="welcome-muted text-sm mt-1">
                  {t(
                    "welcomeMcpConfigDesc",
                    "Use this in your MCP client. No localhost HTTP URL is required.",
                  )}
                </p>

                <div className="welcome-command-row mt-3 flex items-center justify-between gap-3 px-4 py-3">
                  <code className="welcome-code text-sm break-all whitespace-pre-wrap">
                    {commands.mcpConfig}
                  </code>
                  <button
                    type="button"
                    className="welcome-mono px-2 py-1 text-xs font-medium ac-btn flex-shrink-0"
                    style={{ color: copyColor(copiedKey, "mcpConfig") }}
                    onClick={() => void copyCommand("mcpConfig")}
                  >
                    {copyLabel("mcpConfig")}
                  </button>
                </div>

                <p className="welcome-subtle text-xs mt-3">
                  {t(
                    "welcomeConnectTip",
                    'Tip: You can also open the extension popup and click "Connect" to copy a full client config snippet.',
                  )}
                </p>
              </div>
            </section>

            <details className="welcome-card overflow-hidden">
              <summary className="px-6 py-4 cursor-pointer select-none flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <div className="welcome-title text-sm font-medium">
                    {t("popupTroubleshootingTitle", "Troubleshooting")}
                  </div>
                  <div className="welcome-muted text-xs truncate">
                    {t(
                      "welcomeTroubleshootingDesc",
                      "Use these only if the Connector fails to register or connect.",
                    )}
                  </div>
                </div>
                <span className="welcome-mono welcome-subtle text-xs flex-shrink-0">
                  {t("welcomeTroubleshootingCommands", "doctor | report")}
                </span>
              </summary>

              <div className="px-6 pb-6 space-y-4">
                <div className="welcome-alt-row p-4">
                  <div className="text-sm font-medium">
                    {t("welcomeDiagnosticsTitle", "Diagnostics")}
                  </div>
                  <p className="welcome-muted text-sm mt-1">
                    {t(
                      "welcomeDiagnosticsDesc",
                      'Run "doctor" to check installation status. If it reports an error, run the auto-fix command.',
                    )}
                  </p>

                  <div className="mt-3 space-y-2">
                    {DIAGNOSTICS.map((item) => (
                      <div
                        key={item.key}
                        className="welcome-command-row flex items-center justify-between gap-3 px-3 py-2"
                      >
                        <div className="min-w-0">
                          <div className="welcome-mono welcome-subtle text-[10px] uppercase tracking-widest font-medium">
                            {t(item.labelKey, item.fallback)}
                          </div>
                          <code className="welcome-code text-xs break-all">{commands[item.key]}</code>
                        </div>
                        <button
                          type="button"
                          className="welcome-mono px-2 py-1 text-xs font-medium ac-btn flex-shrink-0"
                          style={{ color: copyColor(copiedKey, item.key) }}
                          onClick={() => void copyCommand(item.key)}
                        >
                          {copyLabel(item.key)}
                        </button>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="welcome-report-card p-4">
                  <div className="text-sm font-medium" style={{ color: "var(--ac-danger)" }}>
                    {t("welcomeReportIssueTitle", "Report an issue")}
                  </div>
                  <p className="welcome-muted text-sm mt-1">
                    {t(
                      "welcomeReportIssueDesc",
                      "Generate a diagnostic report and paste it into a GitHub issue.",
                    )}
                  </p>

                  <div className="welcome-command-row mt-3 flex items-center justify-between gap-3 px-3 py-2">
                    <code className="welcome-code text-xs break-all">{commands.report}</code>
                    <button
                      type="button"
                      className="welcome-mono px-2 py-1 text-xs font-medium ac-btn flex-shrink-0"
                      style={{ color: copyColor(copiedKey, "report") }}
                      onClick={() => void copyCommand("report")}
                    >
                      {copyLabel("report")}
                    </button>
                  </div>

                  <p className="welcome-subtle text-xs mt-2">
                    {t(
                      "welcomeReportIssueTip",
                      "This copies the report to your clipboard (sensitive info is automatically redacted).",
                    )}
                  </p>
                </div>

                <div className="flex">
                  <button
                    type="button"
                    className="welcome-button px-3 py-2 text-xs font-medium ac-btn"
                    onClick={() => void openDocs()}
                  >
                    {t("welcomeOpenTroubleshootingDocs", "Open troubleshooting docs")}
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
