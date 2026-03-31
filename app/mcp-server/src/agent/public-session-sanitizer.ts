import type { AgentSession, ManagementInfo, SessionOptionsConfig } from './session-service';

function sanitizeOptionsConfigForPublicRead(
  optionsConfig?: SessionOptionsConfig,
): SessionOptionsConfig | undefined {
  if (!optionsConfig) {
    return undefined;
  }

  const { env: _env, ...rest } = optionsConfig;
  return Object.keys(rest).length > 0 ? rest : undefined;
}

export function sanitizeManagementInfoForPublicRead(
  managementInfo?: ManagementInfo | null,
): ManagementInfo | null | undefined {
  if (managementInfo === null) {
    return null;
  }
  if (!managementInfo) {
    return undefined;
  }

  const { cwd: _cwd, plugins, ...rest } = managementInfo;
  const sanitizedPlugins = plugins?.map((plugin) => ({ name: plugin.name }));

  const sanitized: ManagementInfo = {
    ...rest,
    ...(sanitizedPlugins ? { plugins: sanitizedPlugins } : {}),
  };

  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

export function sanitizeSessionForPublicRead(session: AgentSession): AgentSession {
  return {
    ...session,
    optionsConfig: sanitizeOptionsConfigForPublicRead(session.optionsConfig),
    managementInfo: sanitizeManagementInfoForPublicRead(session.managementInfo) ?? undefined,
  };
}
