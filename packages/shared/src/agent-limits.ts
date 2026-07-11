/** UTF-8 and JSON byte budgets for agent chat input and persisted messages. */
export const AGENT_MESSAGE_CONTENT_MAX_BYTES = 192 * 1024;
export const AGENT_MESSAGE_METADATA_MAX_JSON_BYTES = 64 * 1024;
export const AGENT_STORED_MESSAGE_MAX_JSON_BYTES = 256 * 1024;
export const AGENT_IDENTIFIER_MAX_BYTES = 256;
export const AGENT_MODEL_MAX_BYTES = 512;
export const AGENT_CLI_SOURCE_MAX_BYTES = 128;
export const AGENT_PROJECT_ROOT_MAX_BYTES = 16 * 1024;
export const AGENT_CREATED_AT_MAX_BYTES = 128;

export const AGENT_CONTEXT_PAGE_URL_MAX_BYTES = 16 * 1024;
export const AGENT_CONTEXT_SELECTED_TEXT_MAX_BYTES = 96 * 1024;
export const AGENT_CONTEXT_ELEMENT_INFO_MAX_JSON_BYTES = 32 * 1024;
export const AGENT_CONTEXT_MAX_JSON_BYTES = 160 * 1024;

export const AGENT_CLIENT_META_MAX_JSON_BYTES = 48 * 1024;
export const AGENT_DISPLAY_TEXT_MAX_BYTES = 8 * 1024;
export const AGENT_ACT_NON_ATTACHMENT_MAX_JSON_BYTES = 448 * 1024;
export const AGENT_FINAL_PROMPT_MAX_BYTES = 384 * 1024;

/** UTF-8 and serialized JSON budgets for persisted agent session settings. */
export const AGENT_SESSION_NAME_MAX_BYTES = 4 * 1024;
export const AGENT_SYSTEM_PROMPT_TEXT_MAX_BYTES = 128 * 1024;
export const AGENT_SYSTEM_PROMPT_CONFIG_MAX_JSON_BYTES = 132 * 1024;
export const AGENT_CODEX_AUTO_INSTRUCTIONS_MAX_BYTES = 128 * 1024;
export const AGENT_SESSION_OPTIONS_MAX_JSON_BYTES = 188 * 1024;
export const AGENT_SESSION_CONFIG_MAX_JSON_BYTES = 320 * 1024;
export const AGENT_SESSION_OPTION_STRING_MAX_BYTES = 8 * 1024;
export const AGENT_MANAGEMENT_INFO_MAX_JSON_BYTES = 256 * 1024;
/** Runtime work caps shared by Claude options and nested Codex options. */
export const AGENT_SESSION_MAX_TURNS = 256;
export const AGENT_SESSION_MAX_THINKING_TOKENS = 128 * 1024;

/** Per-request agent stream limits shared by producers and downstream relays. */
export const AGENT_STREAM_MAX_EVENTS_PER_REQUEST = 512;
export const AGENT_STREAM_MAX_JSON_BYTES_PER_REQUEST = 4 * 1024 * 1024;
export const AGENT_STREAM_MAX_ERROR_BYTES = 8 * 1024;
export const AGENT_STREAM_MAX_STATUS_MESSAGE_BYTES = 4 * 1024;

/** UTF-8 and JSON budgets for project persistence and project-opening RPCs. */
export const AGENT_PROJECT_NAME_MAX_BYTES = 4 * 1024;
export const AGENT_PROJECT_DESCRIPTION_MAX_BYTES = 64 * 1024;
export const AGENT_PROJECT_UPSERT_MAX_JSON_BYTES = 96 * 1024;
export const AGENT_PROJECT_LOCATION_MAX = 10_000_000;
