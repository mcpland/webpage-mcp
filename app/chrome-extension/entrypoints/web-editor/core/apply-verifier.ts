import type {
  ElementChangeSummary,
  ElementLocator,
  Transaction,
  WebEditorElementKey,
} from "@/common/web-editor-types";
import { compareComputed, normalizeText, readComputedMap } from "./css-compare";
import { locateElement } from "./locator";

export type ApplyVerificationStatus =
  | "verified"
  | "mismatch"
  | "lost"
  | "uncertain";

export interface ApplyVerificationTarget {
  elementKey: WebEditorElementKey;
  locator: ElementLocator;
  expectedText?: string;
  expectedClasses?: string[];
  expectedComputedStyles?: Record<string, string>;
}

export interface ApplyVerificationSnapshot {
  targets: ApplyVerificationTarget[];
}

export interface ApplyVerificationResult {
  status: ApplyVerificationStatus;
  message: string;
}

export interface ApplyVerificationOptions {
  attempts?: number;
  settleDelayMs?: number;
}

const DEFAULT_ATTEMPTS = 6;
const DEFAULT_SETTLE_DELAY_MS = 250;
const HEAD_MUTATION_OPTIONS: MutationObserverInit = {
  childList: true,
  subtree: true,
  characterData: true,
  attributes: true,
};
const DOM_MUTATION_OPTIONS: MutationObserverInit = {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ["class", "style", "id"],
  characterData: true,
};

interface ElementVerificationResult {
  status: ApplyVerificationStatus;
}

interface ApplyVerificationSignals {
  hadRelevantMutation: boolean;
  hadElementDisconnect: boolean;
}

interface ApplyVerificationObservationContext {
  originalElement: Element | null;
  documents: Document[];
  domTargets: Node[];
  allowRootLevelMutationSignal: boolean;
}

function uniqueNodes<T extends Node>(
  nodes: readonly (T | null | undefined)[],
): T[] {
  const seen = new Set<T>();
  const out: T[] = [];

  for (const node of nodes) {
    if (!node || seen.has(node)) continue;
    seen.add(node);
    out.push(node);
  }

  return out;
}

function safeQuerySelector(root: ParentNode, selector: string): Element | null {
  try {
    return root.querySelector(selector);
  } catch {
    return null;
  }
}

function isSelectorUnique(root: ParentNode, selector: string): boolean {
  try {
    return root.querySelectorAll(selector).length === 1;
  } catch {
    return false;
  }
}

function resolveObservationContext(
  locator: ElementLocator,
  rootDocument: Document = document,
): Pick<ApplyVerificationObservationContext, "documents" | "domTargets"> {
  let doc = rootDocument;

  if (locator.frameChain?.length) {
    for (const frameSelector of locator.frameChain) {
      if (!isSelectorUnique(doc, frameSelector)) {
        break;
      }
      const frame = safeQuerySelector(doc, frameSelector);
      if (!(frame instanceof HTMLIFrameElement) || !frame.contentDocument) {
        break;
      }
      doc = frame.contentDocument;
    }
  }

  let queryRoot: Document | ShadowRoot = doc;
  const domTargets: Node[] = [];

  if (locator.shadowHostChain?.length) {
    for (const hostSelector of locator.shadowHostChain) {
      if (!isSelectorUnique(queryRoot, hostSelector)) {
        break;
      }
      const host = safeQuerySelector(queryRoot, hostSelector);
      if (!(host instanceof Element)) {
        break;
      }
      const shadowRoot = (host as Element & { shadowRoot?: ShadowRoot | null })
        .shadowRoot;
      if (!shadowRoot) {
        break;
      }
      domTargets.push(shadowRoot);
      queryRoot = shadowRoot;
    }
  }

  return {
    documents: [doc],
    domTargets,
  };
}

function buildObservationContexts(
  snapshot: ApplyVerificationSnapshot,
): ApplyVerificationObservationContext[] {
  return snapshot.targets.map((target) => {
    const originalElement = locateElement(target.locator);
    const resolvedContext = resolveObservationContext(target.locator);

    return {
      originalElement,
      documents: resolvedContext.documents,
      domTargets: resolvedContext.domTargets,
      allowRootLevelMutationSignal: !originalElement,
    };
  });
}

function normalizeClassList(classes: readonly string[]): string[] {
  return Array.from(
    new Set(classes.map((value) => String(value ?? "").trim()).filter(Boolean)),
  ).sort();
}

function buildExpectedTarget(
  elementKey: WebEditorElementKey,
  locator: ElementLocator,
  options: {
    includeText: boolean;
    expectedText?: string;
    includeClasses: boolean;
    expectedClasses?: readonly string[];
    styleProperties: readonly string[];
  },
): ApplyVerificationTarget | null {
  const liveElement = locateElement(locator);

  const expectedText = options.includeText
    ? normalizeText(options.expectedText ?? liveElement?.textContent ?? "")
    : undefined;

  const expectedClasses = options.includeClasses
    ? normalizeClassList(
        options.expectedClasses ??
          (liveElement ? Array.from(liveElement.classList) : []),
      )
    : undefined;

  const expectedComputedStyles =
    options.styleProperties.length > 0 && liveElement
      ? readComputedMap(liveElement, options.styleProperties)
      : undefined;

  if (
    expectedText === undefined &&
    expectedClasses === undefined &&
    expectedComputedStyles === undefined
  ) {
    return null;
  }

  return {
    elementKey,
    locator,
    expectedText,
    expectedClasses,
    expectedComputedStyles,
  };
}

export function createApplyVerificationSnapshotFromSummaries(
  summaries: readonly ElementChangeSummary[],
): ApplyVerificationSnapshot | null {
  const targets = summaries
    .map((summary) => {
      const styleChange = summary.netEffect.styleChanges;
      const textChange = summary.netEffect.textChange;
      const classChange = summary.netEffect.classChanges;
      const styleProperties = Array.from(
        new Set([
          ...Object.keys(styleChange?.before ?? {}),
          ...Object.keys(styleChange?.after ?? {}),
        ]),
      );

      return buildExpectedTarget(summary.elementKey, summary.locator, {
        includeText: !!textChange,
        expectedText: textChange?.after,
        includeClasses: !!classChange,
        expectedClasses: classChange?.after,
        styleProperties,
      });
    })
    .filter((target): target is ApplyVerificationTarget => target !== null);

  return targets.length > 0 ? { targets } : null;
}

export function createApplyVerificationSnapshotFromTransaction(
  tx: Transaction,
): ApplyVerificationSnapshot | null {
  const styleProperties =
    tx.type === "style"
      ? Array.from(
          new Set([
            ...Object.keys(tx.before.styles ?? {}),
            ...Object.keys(tx.after.styles ?? {}),
          ]),
        )
      : [];

  const target = buildExpectedTarget(tx.elementKey ?? tx.id, tx.targetLocator, {
    includeText: tx.type === "text",
    expectedText: tx.after.text,
    includeClasses: tx.type === "class",
    expectedClasses: tx.after.classes,
    styleProperties,
  });

  return target ? { targets: [target] } : null;
}

function verifyTarget(
  target: ApplyVerificationTarget,
): ElementVerificationResult {
  const element = locateElement(target.locator);
  if (!element || !element.isConnected) {
    return { status: "lost" };
  }

  let checks = 0;

  if (target.expectedText !== undefined) {
    checks += 1;
    if (normalizeText(element.textContent ?? "") !== target.expectedText) {
      return { status: "mismatch" };
    }
  }

  if (target.expectedClasses !== undefined) {
    checks += 1;
    const actualClasses = normalizeClassList(Array.from(element.classList));
    if (actualClasses.join("\n") !== target.expectedClasses.join("\n")) {
      return { status: "mismatch" };
    }
  }

  if (target.expectedComputedStyles !== undefined) {
    checks += 1;
    const actualStyles = readComputedMap(
      element,
      Object.keys(target.expectedComputedStyles),
    );
    if (!compareComputed(target.expectedComputedStyles, actualStyles).matches) {
      return { status: "mismatch" };
    }
  }

  if (checks === 0) {
    return { status: "uncertain" };
  }

  return { status: "verified" };
}

function summarizeResults(
  results: readonly ElementVerificationResult[],
): ApplyVerificationResult {
  const total = results.length;
  const verified = results.filter(
    (result) => result.status === "verified",
  ).length;
  const mismatches = results.filter(
    (result) => result.status === "mismatch",
  ).length;
  const lost = results.filter((result) => result.status === "lost").length;

  if (mismatches > 0) {
    return {
      status: "mismatch",
      message: `Post-apply mismatch on ${mismatches}/${total} element${mismatches === 1 ? "" : "s"}`,
    };
  }

  if (verified === total && total > 0) {
    return {
      status: "verified",
      message: `Verified ${verified}/${total} applied element${verified === 1 ? "" : "s"}`,
    };
  }

  if (lost === total && total > 0) {
    return {
      status: "lost",
      message: `Unable to re-locate ${lost}/${total} applied element${lost === 1 ? "" : "s"}`,
    };
  }

  return {
    status: "uncertain",
    message: "Applied changes could not be fully verified",
  };
}

function mergeSignals(
  current: ApplyVerificationSignals,
  next: ApplyVerificationSignals,
): ApplyVerificationSignals {
  return {
    hadRelevantMutation:
      current.hadRelevantMutation || next.hadRelevantMutation,
    hadElementDisconnect:
      current.hadElementDisconnect || next.hadElementDisconnect,
  };
}

function markDisconnectIfNeeded(
  originalElements: readonly (Element | null)[],
  signals: ApplyVerificationSignals,
): void {
  if (signals.hadElementDisconnect) return;
  for (const element of originalElements) {
    if (element && !element.isConnected) {
      signals.hadElementDisconnect = true;
      signals.hadRelevantMutation = true;
      return;
    }
  }
}

function isDomMutationRelevant(
  record: MutationRecord,
  originalElements: readonly (Element | null)[],
): boolean {
  for (const target of originalElements) {
    if (!target) continue;

    const recordTarget = record.target;
    if (record.type === "characterData") {
      if (recordTarget instanceof Text) {
        const parent = recordTarget.parentElement;
        if (
          parent &&
          (parent === target ||
            parent.contains(target) ||
            target.contains(parent))
        ) {
          return true;
        }
      }
      continue;
    }

    if (record.type === "attributes") {
      if (!(recordTarget instanceof Element)) continue;
      try {
        if (
          recordTarget === target ||
          recordTarget.contains(target) ||
          target.contains(recordTarget)
        ) {
          return true;
        }
      } catch {
        continue;
      }
    }

    if (record.type === "childList") {
      if (recordTarget instanceof ShadowRoot) {
        if (recordTarget === target.getRootNode()) {
          return true;
        }
      } else if (recordTarget instanceof Element) {
        try {
          if (
            recordTarget === target ||
            recordTarget.contains(target) ||
            target.contains(recordTarget)
          ) {
            return true;
          }
        } catch {
          // Fall through to removed-node checks
        }
      }

      for (const node of record.removedNodes) {
        if (node === target) return true;
        if (node instanceof Element) {
          try {
            if (node.contains(target)) return true;
          } catch {
            // Ignore invalid tree state during mutation delivery
          }
        }
      }
    }
  }

  return false;
}

async function observeVerificationSignals(
  snapshot: ApplyVerificationSnapshot,
  delayMs: number,
): Promise<ApplyVerificationSignals> {
  const observationContexts = buildObservationContexts(snapshot);
  const originalElements = observationContexts.map(
    (context) => context.originalElement,
  );
  const rootNodes = uniqueNodes([
    ...originalElements.map((element) => element?.getRootNode?.() ?? null),
    ...observationContexts.flatMap((context) => context.domTargets),
  ]);
  const observedDocuments = uniqueNodes(
    [
      ...rootNodes.map((root) =>
        root instanceof Document
          ? root
          : root instanceof ShadowRoot
            ? root.ownerDocument
            : null,
      ),
      ...observationContexts.flatMap((context) => context.documents),
    ].filter((doc): doc is Document => doc instanceof Document),
  );
  const observedDomTargets = new Map<Node, boolean>();

  for (const context of observationContexts) {
    const contextDomTargets = [
      ...context.domTargets,
      ...context.documents
        .map((doc) => doc.body ?? doc.documentElement)
        .filter((node): node is HTMLElement => node instanceof HTMLElement),
    ];
    for (const target of contextDomTargets) {
      observedDomTargets.set(
        target,
        (observedDomTargets.get(target) ?? false) ||
          context.allowRootLevelMutationSignal,
      );
    }
  }

  const signals: ApplyVerificationSignals = {
    hadRelevantMutation: false,
    hadElementDisconnect: false,
  };

  markDisconnectIfNeeded(originalElements, signals);
  if (delayMs <= 0) {
    return signals;
  }

  return await new Promise((resolve) => {
    let settled = false;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      for (const observer of headObservers) {
        observer.disconnect();
      }
      for (const observer of domObservers) {
        observer.disconnect();
      }
      markDisconnectIfNeeded(originalElements, signals);
      resolve(signals);
    };

    const headObservers =
      typeof MutationObserver !== "undefined"
        ? observedDocuments
            .map((doc) => {
              if (!doc.head) return null;
              const observer = new MutationObserver(() => {
                signals.hadRelevantMutation = true;
              });
              observer.observe(doc.head, HEAD_MUTATION_OPTIONS);
              return observer;
            })
            .filter(
              (observer): observer is MutationObserver => observer !== null,
            )
        : [];

    const domObservers =
      typeof MutationObserver !== "undefined"
        ? Array.from(observedDomTargets.entries()).map(
            ([target, allowRootLevelMutationSignal]) => {
              const observer = new MutationObserver((records) => {
                markDisconnectIfNeeded(originalElements, signals);
                if (
                  allowRootLevelMutationSignal ||
                  records.some((record) =>
                    isDomMutationRelevant(record, originalElements),
                  )
                ) {
                  signals.hadRelevantMutation = true;
                }
              });
              observer.observe(target, DOM_MUTATION_OPTIONS);
              return observer;
            },
          )
        : [];

    window.setTimeout(finish, delayMs);
  });
}

function finalizeVerificationResult(
  latest: ApplyVerificationResult,
  signals: ApplyVerificationSignals,
): ApplyVerificationResult {
  if (latest.status !== "verified") {
    return latest;
  }

  if (signals.hadRelevantMutation || signals.hadElementDisconnect) {
    return latest;
  }

  return {
    status: "uncertain",
    message: "No HMR signal observed after apply",
  };
}

export async function verifyApplySnapshotSettled(
  snapshot: ApplyVerificationSnapshot,
  options: ApplyVerificationOptions = {},
): Promise<ApplyVerificationResult> {
  const attempts = Math.max(
    1,
    Math.floor(options.attempts ?? DEFAULT_ATTEMPTS),
  );
  const settleDelayMs = Math.max(
    0,
    Math.floor(options.settleDelayMs ?? DEFAULT_SETTLE_DELAY_MS),
  );

  let latest = summarizeResults(snapshot.targets.map(verifyTarget));
  let signals: ApplyVerificationSignals = {
    hadRelevantMutation: false,
    hadElementDisconnect: false,
  };

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    signals = mergeSignals(
      signals,
      await observeVerificationSignals(snapshot, settleDelayMs),
    );
    latest = summarizeResults(snapshot.targets.map(verifyTarget));
    if (
      latest.status === "verified" &&
      (signals.hadRelevantMutation || signals.hadElementDisconnect)
    ) {
      break;
    }
  }

  return finalizeVerificationResult(latest, signals);
}
