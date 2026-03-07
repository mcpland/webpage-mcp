import { useMemo, useState } from "react";
import { LINKS } from "@/common/constants";
import { getMessage } from "@/utils/i18n";

import "../sidepanel/styles/connector-theme.css";
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
      <div className="welcome-layout">
        <header className="welcome-header">
          <div className="welcome-header-inner">
            <div className="welcome-header-brand">
              <div className="welcome-icon" aria-hidden="true">
                <svg
                  className="welcome-icon-svg"
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
              <div className="welcome-header-text">
                <h1 className="welcome-title welcome-header-title">
                  {t("welcomeHeaderTitle", "Webpage MCP Connector")}
                </h1>
                <p className="welcome-muted welcome-header-subtitle">
                  {t(
                    "welcomeHeaderSubtitle",
                    "Extension-aware setup commands (includes this extension ID).",
                  )}
                </p>
              </div>
            </div>

            <button
              type="button"
              className="welcome-button"
              onClick={() => void openDocs()}
            >
              {t("welcomeTroubleshootingDocsButton", "Troubleshooting Docs")}
            </button>
          </div>
        </header>

        <main className="welcome-main">
          <div className="welcome-main-inner">
            {/* MCP Server Setup — primary card */}
            <section className="welcome-card welcome-card--primary welcome-card-body">
              <h2 className="welcome-title welcome-title-xl">
                {t("welcomeMcpServerSetupTitle", "MCP Server Setup")}
              </h2>
              <p className="welcome-muted welcome-text-sm welcome-mt-2">
                {t(
                  "welcomeMcpServerSetupDesc",
                  "Start the MCP server with your MCP client using the config below. The server automatically registers the native host on first run.",
                )}
              </p>

              <div className="welcome-section-content">
                <h3 className="welcome-title welcome-title-sm">
                  {t("welcomeStdioCommandTitle", "MCP stdio command")}
                </h3>
                <p className="welcome-muted welcome-text-sm welcome-mt-1">
                  {t(
                    "welcomeStdioCommandDesc",
                    "Then use this command in your MCP client. No global install and no localhost URL are required.",
                  )}
                </p>

                <div className="welcome-command-row welcome-mt-3">
                  <code className="welcome-code welcome-code-sm">{commands.stdioCommand}</code>
                  <button
                    type="button"
                    className="welcome-copy-btn"
                    style={{ color: copyColor(copiedKey, "stdioCommand") }}
                    onClick={() => void copyCommand("stdioCommand")}
                  >
                    {copyLabel("stdioCommand")}
                  </button>
                </div>

                <h3 className="welcome-title welcome-title-sm welcome-mt-4">
                  {t("welcomeMcpConfigTitle", "MCP client config (stdio)")}
                </h3>
                <p className="welcome-muted welcome-text-sm welcome-mt-1">
                  {t(
                    "welcomeMcpConfigDesc",
                    "Use this in your MCP client. No localhost HTTP URL is required.",
                  )}
                </p>

                <div className="welcome-command-row welcome-mt-3">
                  <code className="welcome-code welcome-code-sm welcome-code-pre">
                    {commands.mcpConfig}
                  </code>
                  <button
                    type="button"
                    className="welcome-copy-btn"
                    style={{ color: copyColor(copiedKey, "mcpConfig") }}
                    onClick={() => void copyCommand("mcpConfig")}
                  >
                    {copyLabel("mcpConfig")}
                  </button>
                </div>

                <p className="welcome-subtle welcome-text-xs welcome-mt-3">
                  {t(
                    "welcomeConnectTip",
                    "Tip: You can also open the extension popup and use the status refresh button to reconnect and sync status before copying a full client config snippet.",
                  )}
                </p>
              </div>
            </section>

            {/* Manual Registration — collapsible fallback */}
            <details className="welcome-card welcome-details">
              <summary className="welcome-details-summary">
                <div className="welcome-details-summary-text">
                  <div className="welcome-title welcome-title-sm">
                    {t("welcomeManualRegistrationTitle", "Manual Registration (fallback)")}
                  </div>
                  <div className="welcome-muted welcome-text-xs welcome-truncate">
                    {t(
                      "welcomeManualRegistrationDesc",
                      "Only needed if auto-registration fails. Requires Node.js.",
                    )}
                  </div>
                </div>
              </summary>

              <div className="welcome-details-body">
                <p className="welcome-muted welcome-text-sm">
                  {t(
                    "welcomeRegisterHostDesc",
                    "Run this command first. It writes the Native Messaging manifest with your current extension ID so Chrome can launch the local host process.",
                  )}
                </p>

                <div className="welcome-command-row">
                  <code className="welcome-code welcome-code-sm">{commands.register}</code>
                  <button
                    type="button"
                    className="welcome-copy-btn"
                    style={{ color: copyColor(copiedKey, "register") }}
                    onClick={() => void copyCommand("register")}
                  >
                    {copyLabel("register")}
                  </button>
                </div>

                <div className="welcome-alt-row welcome-muted welcome-text-xs">
                  {t("welcomeCurrentExtensionId", "Current extension ID:")}{" "}
                  <code className="welcome-code welcome-code-inline">{extensionId}</code>
                </div>
              </div>
            </details>

            {/* Troubleshooting — collapsible */}
            <details className="welcome-card welcome-details">
              <summary className="welcome-details-summary">
                <div className="welcome-details-summary-text">
                  <div className="welcome-title welcome-title-sm">
                    {t("popupTroubleshootingTitle", "Troubleshooting")}
                  </div>
                  <div className="welcome-muted welcome-text-xs welcome-truncate">
                    {t(
                      "welcomeTroubleshootingDesc",
                      "Use these only if the Connector fails to register or connect.",
                    )}
                  </div>
                </div>
                <span className="welcome-mono welcome-subtle welcome-text-xs">
                  {t("welcomeTroubleshootingCommands", "doctor | report")}
                </span>
              </summary>

              <div className="welcome-details-body welcome-details-body--lg">
                <div className="welcome-alt-row welcome-alt-row--padded">
                  <div className="welcome-title-sm">
                    {t("welcomeDiagnosticsTitle", "Diagnostics")}
                  </div>
                  <p className="welcome-muted welcome-text-sm welcome-mt-1">
                    {t(
                      "welcomeDiagnosticsDesc",
                      'Run "doctor" to check installation status. If it reports an error, run the auto-fix command.',
                    )}
                  </p>

                  <div className="welcome-diagnostics-list">
                    {DIAGNOSTICS.map((item) => (
                      <div key={item.key} className="welcome-command-row welcome-command-row--compact">
                        <div className="welcome-command-info">
                          <div className="welcome-mono welcome-subtle welcome-command-label">
                            {t(item.labelKey, item.fallback)}
                          </div>
                          <code className="welcome-code welcome-code-xs">{commands[item.key]}</code>
                        </div>
                        <button
                          type="button"
                          className="welcome-copy-btn"
                          style={{ color: copyColor(copiedKey, item.key) }}
                          onClick={() => void copyCommand(item.key)}
                        >
                          {copyLabel(item.key)}
                        </button>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="welcome-report-card">
                  <div className="welcome-title-sm" style={{ color: "var(--ac-danger)" }}>
                    {t("welcomeReportIssueTitle", "Report an issue")}
                  </div>
                  <p className="welcome-muted welcome-text-sm welcome-mt-1">
                    {t(
                      "welcomeReportIssueDesc",
                      "Generate a diagnostic report and paste it into a GitHub issue.",
                    )}
                  </p>

                  <div className="welcome-command-row welcome-command-row--compact welcome-mt-3">
                    <code className="welcome-code welcome-code-xs">{commands.report}</code>
                    <button
                      type="button"
                      className="welcome-copy-btn"
                      style={{ color: copyColor(copiedKey, "report") }}
                      onClick={() => void copyCommand("report")}
                    >
                      {copyLabel("report")}
                    </button>
                  </div>

                  <p className="welcome-subtle welcome-text-xs welcome-mt-2">
                    {t(
                      "welcomeReportIssueTip",
                      "This copies the report to your clipboard (sensitive info is automatically redacted).",
                    )}
                  </p>
                </div>

                <div>
                  <button
                    type="button"
                    className="welcome-button"
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
