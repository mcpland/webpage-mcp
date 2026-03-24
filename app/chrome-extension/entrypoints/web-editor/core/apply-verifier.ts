import type {
  ElementChangeSummary,
  ElementLocator,
  Transaction,
  WebEditorElementKey,
} from '@/common/web-editor-types';
import { compareComputed, normalizeText, readComputedMap } from './css-compare';
import { locateElement } from './locator';

export type ApplyVerificationStatus = 'verified' | 'mismatch' | 'lost' | 'uncertain';

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

interface ElementVerificationResult {
  status: ApplyVerificationStatus;
}

function normalizeClassList(classes: readonly string[]): string[] {
  return Array.from(
    new Set(
      classes
        .map((value) => String(value ?? '').trim())
        .filter(Boolean),
    ),
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
    ? normalizeText(liveElement?.textContent ?? options.expectedText ?? '')
    : undefined;

  const expectedClasses = options.includeClasses
    ? normalizeClassList(
        liveElement ? Array.from(liveElement.classList) : (options.expectedClasses ?? []),
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
    tx.type === 'style'
      ? Array.from(new Set([...Object.keys(tx.before.styles ?? {}), ...Object.keys(tx.after.styles ?? {})]))
      : [];

  const target = buildExpectedTarget(tx.elementKey ?? tx.id, tx.targetLocator, {
    includeText: tx.type === 'text',
    expectedText: tx.after.text,
    includeClasses: tx.type === 'class',
    expectedClasses: tx.after.classes,
    styleProperties,
  });

  return target ? { targets: [target] } : null;
}

function verifyTarget(target: ApplyVerificationTarget): ElementVerificationResult {
  const element = locateElement(target.locator);
  if (!element || !element.isConnected) {
    return { status: 'lost' };
  }

  let checks = 0;

  if (target.expectedText !== undefined) {
    checks += 1;
    if (normalizeText(element.textContent ?? '') !== target.expectedText) {
      return { status: 'mismatch' };
    }
  }

  if (target.expectedClasses !== undefined) {
    checks += 1;
    const actualClasses = normalizeClassList(Array.from(element.classList));
    if (actualClasses.join('\n') !== target.expectedClasses.join('\n')) {
      return { status: 'mismatch' };
    }
  }

  if (target.expectedComputedStyles !== undefined) {
    checks += 1;
    const actualStyles = readComputedMap(element, Object.keys(target.expectedComputedStyles));
    if (!compareComputed(target.expectedComputedStyles, actualStyles).matches) {
      return { status: 'mismatch' };
    }
  }

  if (checks === 0) {
    return { status: 'uncertain' };
  }

  return { status: 'verified' };
}

function summarizeResults(results: readonly ElementVerificationResult[]): ApplyVerificationResult {
  const total = results.length;
  const verified = results.filter((result) => result.status === 'verified').length;
  const mismatches = results.filter((result) => result.status === 'mismatch').length;
  const lost = results.filter((result) => result.status === 'lost').length;

  if (mismatches > 0) {
    return {
      status: 'mismatch',
      message: `Post-apply mismatch on ${mismatches}/${total} element${mismatches === 1 ? '' : 's'}`,
    };
  }

  if (verified === total && total > 0) {
    return {
      status: 'verified',
      message: `Verified ${verified}/${total} applied element${verified === 1 ? '' : 's'}`,
    };
  }

  if (lost === total && total > 0) {
    return {
      status: 'lost',
      message: `Unable to re-locate ${lost}/${total} applied element${lost === 1 ? '' : 's'}`,
    };
  }

  return {
    status: 'uncertain',
    message: 'Applied changes could not be fully verified',
  };
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, delayMs);
  });
}

export async function verifyApplySnapshotSettled(
  snapshot: ApplyVerificationSnapshot,
  options: ApplyVerificationOptions = {},
): Promise<ApplyVerificationResult> {
  const attempts = Math.max(1, Math.floor(options.attempts ?? DEFAULT_ATTEMPTS));
  const settleDelayMs = Math.max(0, Math.floor(options.settleDelayMs ?? DEFAULT_SETTLE_DELAY_MS));

  let latest = summarizeResults(snapshot.targets.map(verifyTarget));

  for (let attempt = 1; attempt < attempts && latest.status !== 'verified'; attempt += 1) {
    if (settleDelayMs > 0) {
      await wait(settleDelayMs);
    }
    latest = summarizeResults(snapshot.targets.map(verifyTarget));
  }

  return latest;
}
