export interface WorkflowRepairRecommendation {
  severity: "info" | "warning";
  code: string;
  message: string;
  nodeId?: string;
  autoFix?:
    | "parameterize_recorded_values"
    | "default_stability_policy"
    | "selector_repair"
    | "wait_repair";
}

export interface WorkflowRepairChange {
  code: string;
  message: string;
  nodeId?: string;
  patch?: Record<string, unknown>;
  reason?: string;
  confidence?: number;
  beforeQuality?: SelectorQualityDiagnostic;
  afterQuality?: SelectorQualityDiagnostic;
}

export interface SelectorQualityDiagnostic {
  primarySelector?: string;
  score: number;
  candidateCount: number;
  bestCandidateScore?: number;
  usesNthOfType: boolean;
  usesXPath: boolean;
  usesDataOrTestId: boolean;
  usesId: boolean;
  usesAriaNameOrRole: boolean;
  hasLocatorMetadata: boolean;
  degraded: boolean;
  resolvedBy?: string;
  fallback?: boolean;
  matchCount?: number;
  fingerprint?: { status?: string; score?: number };
  frameContext?: "top" | "iframe" | "unknown";
  shadowContext?: "present" | "absent" | "unknown";
  reasons: string[];
}

export interface SelectorRepairEvidence {
  hasTargetFailure: boolean;
  hasFailureArtifact: boolean;
  hasSelectorObservation: boolean;
  hasSuccessfulResolution: boolean;
  resolvedBy?: string;
  matchCount?: number;
  fingerprint?: { status?: string; score?: number };
  latestRunId?: string;
}

export interface SelectorRepairPlan {
  op: "replaceTarget" | "backfillTargetMetadata";
  nodeId: string;
  status: "autoPatch" | "suggestion";
  reason: string;
  confidence: number;
  selectorUnique: boolean;
  beforeSelector?: string;
  afterSelector?: string;
  candidateIndex?: number;
  candidate?: Record<string, unknown>;
  beforeQuality: SelectorQualityDiagnostic;
  afterQuality?: SelectorQualityDiagnostic;
  evidence: SelectorRepairEvidence;
}

export type WorkflowWaitConditionPatch =
  | { kind: "navigation" }
  | { kind: "networkIdle"; idleMs?: number }
  | { kind: "selector"; selector: string; visible?: boolean };

export interface WaitRepairEvidence {
  runId?: string;
  observedNodeId?: string;
  eventType?: "navigation.observed" | "network.observed" | "dom.visibility";
  status?: string;
  selector?: string;
  beforeUrl?: string;
  afterUrl?: string;
  resourceType?: string;
  currentFrame?: boolean;
  matchCount?: number;
  requestGroup?: string;
  quietWindowMs?: number;
  longLived?: boolean;
}

export interface WaitRepairPlan {
  op: "addWaitBefore";
  nodeId: string;
  status: "autoPatch" | "suggestion";
  reason: string;
  confidence: number;
  condition: WorkflowWaitConditionPatch;
  evidence: WaitRepairEvidence;
}

export interface AssertionRepairSuggestion {
  op: "addAssertAfter";
  nodeId?: string;
  status: "suggestion";
  reason: string;
  confidence: number;
  assertion?: Record<string, unknown>;
  evidence?: Record<string, unknown>;
}
