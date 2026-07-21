const REDACTED = "<redacted>";

export function redactWorkflowUrl(value: string): string {
  const credentialRedacted = value.replace(
    /^(https?:\/\/)([^/?#@]+)@/i,
    `$1${REDACTED}@`,
  );
  return credentialRedacted.replace(
    /([?&][^=&]*(?:authorization|auth|bearer|cookie|key|password|secret|session|token)[^=&]*=)[^&#]*/gi,
    `$1${REDACTED}`,
  );
}
