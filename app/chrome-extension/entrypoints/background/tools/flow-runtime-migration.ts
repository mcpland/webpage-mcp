import {
  WEBPAGE_MCP_CAPABILITY_VERSION,
  WEBPAGE_MCP_PROTOCOL_VERSION,
} from 'webpage-mcp-shared';
import {
  FLOW_DSL_VERSION,
  FLOW_NODE_SEMANTICS_VERSION,
  FLOW_SCHEMA_VERSION,
  type FlowQualityMeta,
  type FlowV3,
} from '../record-replay-v3/domain/flow';
import type { JsonObject } from '../record-replay-v3/domain/json';
import {
  appendWorkflowAuditEvent,
  buildWorkflowQualitySummary,
  calculateWorkflowRevision,
  getPublishedFlowInfo,
} from '../record-replay-v3/flows/publish';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function createWorkflowMigrationId(): string {
  return `migration-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function buildTargetRuntimeMeta(flow: FlowV3): NonNullable<FlowV3['meta']>['runtime'] {
  return {
    ...(flow.meta?.runtime ?? {}),
    protocolVersion: WEBPAGE_MCP_PROTOCOL_VERSION,
    capabilityVersion: WEBPAGE_MCP_CAPABILITY_VERSION,
    dslVersion: FLOW_DSL_VERSION,
    nodeSemanticsVersion: FLOW_NODE_SEMANTICS_VERSION,
  };
}

type WorkflowRuntimeVersionChange = 'same' | 'patch' | 'minor' | 'major' | 'legacy_unknown' | 'future';
type WorkflowCompatibilityDecision =
  | 'current'
  | 'metadata_only_compatible'
  | 'compatible_patch'
  | 'compatible_minor_unaffected'
  | 'requires_revalidation'
  | 'blocked_breaking_change';

interface ParsedWorkflowRuntimeVersion {
  major: number;
  minor: number;
  patch: number;
}

interface WorkflowRuntimeCompatibility {
  decision: WorkflowCompatibilityDecision;
  staleReason?: string;
  qualityStatus?: 'stale' | 'blocked';
  dslChange: WorkflowRuntimeVersionChange;
  nodeSemanticsChange: WorkflowRuntimeVersionChange;
  affectedNodeKinds: string[];
  affectedFields: string[];
  compatibilityNotes: string[];
}

const DSL_MINOR_AFFECTED_FIELDS = ['/variables', '/meta/exposedOutputs', '/edges'];
const NODE_SEMANTICS_MINOR_AFFECTED_NODE_KINDS = new Set([
  'assert',
  'click',
  'extract',
  'fill',
  'navigate',
  'wait',
]);
const NODE_SEMANTICS_MINOR_AFFECTED_FIELDS = [
  '/nodes/*/config',
  '/nodes/*/policy',
  '/nodes/*/sideEffect',
];

function parseWorkflowRuntimeVersion(value: string | undefined): ParsedWorkflowRuntimeVersion | null {
  if (!value) {
    return null;
  }
  const match = value.trim().match(/^(\d+)(?:[.-](\d+))?(?:[.-](\d+))?/);
  if (!match) {
    return null;
  }
  const major = Number(match[1]);
  const minor = Number(match[2] ?? 0);
  const patch = Number(match[3] ?? 0);
  if (![major, minor, patch].every((part) => Number.isFinite(part) && part >= 0)) {
    return null;
  }
  return { major, minor, patch };
}

function compareParsedWorkflowRuntimeVersion(
  before: ParsedWorkflowRuntimeVersion,
  target: ParsedWorkflowRuntimeVersion,
): number {
  if (before.major !== target.major) return before.major - target.major;
  if (before.minor !== target.minor) return before.minor - target.minor;
  return before.patch - target.patch;
}

function classifyWorkflowRuntimeVersionChange(
  beforeValue: string | undefined,
  targetValue: string,
): WorkflowRuntimeVersionChange {
  if (!beforeValue || beforeValue === targetValue) {
    return 'same';
  }
  const before = parseWorkflowRuntimeVersion(beforeValue);
  const target = parseWorkflowRuntimeVersion(targetValue);
  if (!before || !target) {
    return 'legacy_unknown';
  }
  if (compareParsedWorkflowRuntimeVersion(before, target) > 0) {
    return 'future';
  }
  if (before.major !== target.major) return 'major';
  if (before.minor !== target.minor) return 'minor';
  if (before.patch !== target.patch) return 'patch';
  return 'same';
}

function getWorkflowNodeKinds(flow: FlowV3): string[] {
  return Array.from(new Set((Array.isArray(flow.nodes) ? flow.nodes : []).map((node) => node.kind))).sort();
}

function flowUsesDslMinorAffectedFields(flow: FlowV3): boolean {
  return (
    (Array.isArray(flow.variables) && flow.variables.length > 0) ||
    (Array.isArray(flow.edges) && flow.edges.length > 0) ||
    (Array.isArray(flow.meta?.exposedOutputs) && flow.meta.exposedOutputs.length > 0)
  );
}

function getNodeSemanticsMinorAffectedNodeKinds(flow: FlowV3): string[] {
  return getWorkflowNodeKinds(flow).filter((kind) => NODE_SEMANTICS_MINOR_AFFECTED_NODE_KINDS.has(kind));
}

function evaluateWorkflowRuntimeCompatibility(flow: FlowV3): WorkflowRuntimeCompatibility {
  const runtime = flow.meta?.runtime;
  const dslChange = classifyWorkflowRuntimeVersionChange(runtime?.dslVersion, FLOW_DSL_VERSION);
  const nodeSemanticsChange = classifyWorkflowRuntimeVersionChange(
    runtime?.nodeSemanticsVersion,
    FLOW_NODE_SEMANTICS_VERSION,
  );
  const affectedNodeKinds = new Set<string>();
  const affectedFields = new Set<string>();
  const compatibilityNotes: string[] = [];
  let decision: WorkflowCompatibilityDecision = 'current';
  let staleReason: string | undefined;
  let qualityStatus: 'stale' | 'blocked' | undefined;

  const markCompatible = (nextDecision: WorkflowCompatibilityDecision, note: string) => {
    if (decision === 'current' || decision === 'metadata_only_compatible') {
      decision = nextDecision;
    }
    compatibilityNotes.push(note);
  };
  const markRevalidation = (reason: string, fields: string[], nodeKinds: string[] = []) => {
    if (decision !== 'blocked_breaking_change') {
      decision = 'requires_revalidation';
      staleReason = staleReason ?? reason;
      qualityStatus = qualityStatus ?? 'stale';
    }
    fields.forEach((field) => affectedFields.add(field));
    nodeKinds.forEach((kind) => affectedNodeKinds.add(kind));
  };
  const markBlocked = (reason: string, fields: string[], nodeKinds: string[] = getWorkflowNodeKinds(flow)) => {
    decision = 'blocked_breaking_change';
    staleReason = staleReason ?? reason;
    qualityStatus = 'blocked';
    fields.forEach((field) => affectedFields.add(field));
    nodeKinds.forEach((kind) => affectedNodeKinds.add(kind));
  };

  if (!runtime?.dslVersion && !runtime?.nodeSemanticsVersion) {
    decision = 'metadata_only_compatible';
    compatibilityNotes.push('missing runtime metadata can be backfilled without changing quality');
  }

  if (dslChange === 'patch') {
    markCompatible('compatible_patch', 'DSL patch change is metadata-compatible.');
  } else if (dslChange === 'minor') {
    if (flowUsesDslMinorAffectedFields(flow)) {
      markRevalidation('dsl_minor_affected_fields', DSL_MINOR_AFFECTED_FIELDS);
    } else {
      markCompatible('compatible_minor_unaffected', 'DSL minor change does not affect fields used by this workflow.');
    }
  } else if (dslChange === 'major') {
    markBlocked('dsl_major_mismatch', ['/nodes', '/edges', '/variables', '/meta/exposedOutputs']);
  } else if (dslChange === 'future') {
    markBlocked('dsl_future_version', ['/meta/runtime/dslVersion']);
  } else if (dslChange === 'legacy_unknown') {
    markRevalidation('dsl_version_mismatch', ['/meta/runtime/dslVersion']);
  }

  if (nodeSemanticsChange === 'patch') {
    markCompatible('compatible_patch', 'Node semantics patch change is metadata-compatible.');
  } else if (nodeSemanticsChange === 'minor') {
    const nodeKinds = getNodeSemanticsMinorAffectedNodeKinds(flow);
    if (nodeKinds.length > 0) {
      markRevalidation(
        'node_semantics_minor_affected_nodes',
        NODE_SEMANTICS_MINOR_AFFECTED_FIELDS,
        nodeKinds,
      );
    } else {
      markCompatible(
        'compatible_minor_unaffected',
        'Node semantics minor change does not affect node kinds used by this workflow.',
      );
    }
  } else if (nodeSemanticsChange === 'major') {
    markBlocked(
      'node_semantics_major_mismatch',
      ['/nodes/*/kind', '/nodes/*/config', '/nodes/*/policy', '/nodes/*/sideEffect'],
    );
  } else if (nodeSemanticsChange === 'future') {
    markBlocked('node_semantics_future_version', ['/meta/runtime/nodeSemanticsVersion']);
  } else if (nodeSemanticsChange === 'legacy_unknown') {
    markRevalidation('node_semantics_mismatch', ['/meta/runtime/nodeSemanticsVersion']);
  }

  if (decision === 'current' && runtime && (
    runtime.protocolVersion !== WEBPAGE_MCP_PROTOCOL_VERSION ||
    runtime.capabilityVersion !== WEBPAGE_MCP_CAPABILITY_VERSION
  )) {
    decision = 'metadata_only_compatible';
    compatibilityNotes.push('protocol or capability metadata can be updated without changing workflow quality');
  }

  return {
    decision,
    ...(staleReason ? { staleReason } : {}),
    ...(qualityStatus ? { qualityStatus } : {}),
    dslChange,
    nodeSemanticsChange,
    affectedNodeKinds: Array.from(affectedNodeKinds).sort(),
    affectedFields: Array.from(affectedFields).sort(),
    compatibilityNotes,
  };
}

export function workflowRuntimeRequiresMigration(flow: FlowV3): WorkflowRuntimeCompatibility | null {
  const compatibility = evaluateWorkflowRuntimeCompatibility(flow);
  return compatibility.decision === 'blocked_breaking_change' ? compatibility : null;
}

function normalizeMigrationQuality(
  quality: FlowQualityMeta | undefined,
  compatibility: WorkflowRuntimeCompatibility,
): FlowQualityMeta | undefined {
  if (!quality) {
    return undefined;
  }
  if (!compatibility.staleReason || !compatibility.qualityStatus) {
    return cloneJson(quality);
  }
  const warning = `Quality marked ${compatibility.qualityStatus} by workflow_migrate: ${compatibility.staleReason}`;
  return {
    ...cloneJson(quality),
    status: compatibility.qualityStatus,
    staleReason: compatibility.staleReason,
    revalidation: {
      ...(quality.revalidation ?? {}),
      ...(quality.revalidation?.policy ? { status: 'deferred' as const } : {}),
      lastDeferredReason: compatibility.staleReason,
    },
    warnings: Array.from(new Set([...(quality.warnings ?? []), warning])),
  };
}

function buildMigrationRollbackSnapshot(flow: FlowV3): JsonObject {
  return {
    schemaVersion: flow.schemaVersion,
    updatedAt: flow.updatedAt,
    runtime: flow.meta?.runtime ? cloneJson(flow.meta.runtime as unknown as JsonObject) : null,
    quality: flow.meta?.quality ? cloneJson(flow.meta.quality as unknown as JsonObject) : null,
  };
}

export function getMigrationRollbackSnapshot(flow: FlowV3, migrationId: string): JsonObject | null {
  const events = Array.isArray(flow.meta?.audit?.events) ? flow.meta.audit.events : [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.kind !== 'schema_migration') {
      continue;
    }
    const metadata = event.metadata;
    if (
      metadata &&
      metadata.migrationId === migrationId &&
      isRecord(metadata.rollbackSnapshot)
    ) {
      return metadata.rollbackSnapshot;
    }
  }
  return null;
}

export function buildWorkflowMigrationPlan(flow: FlowV3, migrationId: string): Record<string, unknown> {
  const publishedInfo = getPublishedFlowInfo(flow);
  const targetRuntime = buildTargetRuntimeMeta(flow);
  const changes: Array<Record<string, unknown>> = [];
  const beforeRuntime = flow.meta?.runtime ?? {};
  const compareRuntimeField = (
    field: 'protocolVersion' | 'capabilityVersion' | 'dslVersion' | 'nodeSemanticsVersion',
  ) => {
    if (beforeRuntime[field] !== targetRuntime?.[field]) {
      changes.push({
        code: `runtime_${field}_updated`,
        path: `/meta/runtime/${field}`,
        before: beforeRuntime[field] ?? null,
        after: targetRuntime?.[field] ?? null,
      });
    }
  };

  if (flow.schemaVersion !== FLOW_SCHEMA_VERSION) {
    changes.push({
      code: 'schema_version_updated',
      path: '/schemaVersion',
      before: flow.schemaVersion,
      after: FLOW_SCHEMA_VERSION,
    });
  }
  compareRuntimeField('protocolVersion');
  compareRuntimeField('capabilityVersion');
  compareRuntimeField('dslVersion');
  compareRuntimeField('nodeSemanticsVersion');

  const compatibility = evaluateWorkflowRuntimeCompatibility(flow);
  if (compatibility.staleReason && compatibility.qualityStatus && flow.meta?.quality) {
    changes.push({
      code: compatibility.qualityStatus === 'blocked' ? 'quality_marked_blocked' : 'quality_marked_stale',
      path: '/meta/quality',
      reason: compatibility.staleReason,
      before: buildWorkflowQualitySummary(flow).status,
      after: compatibility.qualityStatus,
    });
  }

  return {
    migrationId,
    flowId: flow.id,
    workflow: publishedInfo?.slug,
    name: flow.name,
    current: {
      schemaVersion: flow.schemaVersion,
      runtime: beforeRuntime,
      quality: buildWorkflowQualitySummary(flow),
    },
    target: {
      schemaVersion: FLOW_SCHEMA_VERSION,
      runtime: targetRuntime,
    },
    compatibility: {
      decision:
        changes.length === 0
          ? 'current'
          : compatibility.decision === 'current'
            ? 'metadata_only_compatible'
            : compatibility.decision,
      staleReason: compatibility.staleReason ?? null,
      qualityStatus: compatibility.qualityStatus ?? null,
      dslChange: compatibility.dslChange,
      nodeSemanticsChange: compatibility.nodeSemanticsChange,
      affectedNodeKinds: compatibility.affectedNodeKinds,
      affectedFields: Array.from(
        new Set([...compatibility.affectedFields, ...changes.map((change) => String(change.path))]),
      ).sort(),
      notes: compatibility.compatibilityNotes,
    },
    rollback: {
      available: true,
      scope: 'workflow_metadata_only',
      externalSideEffectsReversible: false,
    },
    changes,
    changed: changes.length > 0,
  };
}

export function applyWorkflowMigration(flow: FlowV3, migrationId: string): FlowV3 {
  const compatibility = evaluateWorkflowRuntimeCompatibility(flow);
  const beforeQuality = buildWorkflowQualitySummary(flow);
  let nextFlow: FlowV3 = {
    ...cloneJson(flow),
    schemaVersion: FLOW_SCHEMA_VERSION,
    updatedAt: new Date().toISOString() as FlowV3['updatedAt'],
    meta: {
      ...(flow.meta ? cloneJson(flow.meta) : {}),
      runtime: buildTargetRuntimeMeta(flow),
      ...(flow.meta?.quality
        ? { quality: normalizeMigrationQuality(flow.meta.quality, compatibility) }
        : {}),
    },
  };
  const afterQuality = buildWorkflowQualitySummary(nextFlow);
  nextFlow = appendWorkflowAuditEvent(nextFlow, {
    kind: 'schema_migration',
    actor: 'mcp',
    revision: calculateWorkflowRevision(nextFlow),
    previousStatus: beforeQuality.status,
    nextStatus: afterQuality.status,
    reason: 'workflow_migrate_apply',
    metadata: {
      migrationId,
      schemaVersionBefore: flow.schemaVersion,
      schemaVersionAfter: FLOW_SCHEMA_VERSION,
      compatibilityDecision:
        compatibility.decision === 'current' ? 'metadata_only_compatible' : compatibility.decision,
      staleReason: compatibility.staleReason ?? null,
      qualityStatus: compatibility.qualityStatus ?? null,
      dslChange: compatibility.dslChange,
      nodeSemanticsChange: compatibility.nodeSemanticsChange,
      affectedNodeKinds: compatibility.affectedNodeKinds,
      affectedFields: compatibility.affectedFields,
      rollbackSnapshot: buildMigrationRollbackSnapshot(flow),
      externalSideEffectsReversible: false,
    },
  });
  return nextFlow;
}
export function applyWorkflowMigrationRollback(
  flow: FlowV3,
  rollbackMigrationId: string,
  snapshot: JsonObject,
): FlowV3 {
  const beforeQuality = buildWorkflowQualitySummary(flow);
  const restoredRuntime = isRecord(snapshot.runtime) ? cloneJson(snapshot.runtime) : undefined;
  const restoredQuality = isRecord(snapshot.quality) ? cloneJson(snapshot.quality) : undefined;
  const nextMeta: NonNullable<FlowV3['meta']> = {
    ...(flow.meta ? cloneJson(flow.meta) : {}),
  };
  if (restoredRuntime) {
    nextMeta.runtime = restoredRuntime as NonNullable<FlowV3['meta']>['runtime'];
  } else if (nextMeta.runtime) {
    delete nextMeta.runtime;
  }
  if (restoredQuality) {
    nextMeta.quality = restoredQuality as FlowQualityMeta;
  } else if (nextMeta.quality) {
    delete nextMeta.quality;
  }
  let nextFlow: FlowV3 = {
    ...cloneJson(flow),
    schemaVersion: FLOW_SCHEMA_VERSION,
    updatedAt: new Date().toISOString() as FlowV3['updatedAt'],
    meta: nextMeta,
  };
  const afterQuality = buildWorkflowQualitySummary(nextFlow);
  nextFlow = appendWorkflowAuditEvent(nextFlow, {
    kind: 'schema_migration',
    actor: 'mcp',
    revision: calculateWorkflowRevision(nextFlow),
    previousStatus: beforeQuality.status,
    nextStatus: afterQuality.status,
    reason: 'workflow_migrate_rollback',
    metadata: {
      migrationId: createWorkflowMigrationId(),
      rollbackMigrationId,
      restoredRuntime: restoredRuntime ?? null,
      restoredQuality: restoredQuality ? { status: afterQuality.status } : null,
      externalSideEffectsReversible: false,
    },
  });
  return nextFlow;
}
