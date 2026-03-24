import { beforeEach, describe, expect, it } from 'vitest';

import type { ElementChangeSummary, Transaction } from '@/common/web-editor-types';
import {
  createApplyVerificationSnapshotFromSummaries,
  createApplyVerificationSnapshotFromTransaction,
  verifyApplySnapshotSettled,
} from '@/entrypoints/web-editor/core/apply-verifier';
import { createElementLocator } from '@/entrypoints/web-editor/core/locator';

function createSummary(
  element: Element,
  overrides: Partial<ElementChangeSummary['netEffect']>,
): ElementChangeSummary {
  const locator = createElementLocator(element);

  return {
    elementKey: 'target',
    label: 'target',
    fullLabel: 'target',
    locator,
    type: 'mixed',
    changes: {},
    transactionIds: ['tx-1'],
    netEffect: {
      elementKey: 'target',
      locator,
      ...overrides,
    },
    updatedAt: Date.now(),
  };
}

describe('apply-verifier', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('verifies mixed text/class/style changes against the live DOM snapshot', async () => {
    const element = document.createElement('div');
    element.id = 'target';
    element.className = 'card active';
    element.textContent = 'Saved';
    element.style.color = 'rgb(255, 0, 0)';
    document.body.appendChild(element);

    const summary = createSummary(element, {
      textChange: { before: 'Draft', after: 'Saved' },
      classChanges: { before: ['card'], after: ['card', 'active'] },
      styleChanges: {
        before: { color: 'rgb(0, 0, 0)' },
        after: { color: 'rgb(255, 0, 0)' },
      },
    });

    const snapshot = createApplyVerificationSnapshotFromSummaries([summary]);
    expect(snapshot).not.toBeNull();

    const result = await verifyApplySnapshotSettled(snapshot!, { attempts: 1, settleDelayMs: 0 });
    expect(result.status).toBe('verified');
  });

  it('reports mismatch when the located element no longer matches the captured state', async () => {
    const element = document.createElement('div');
    element.id = 'target';
    element.textContent = 'Saved';
    document.body.appendChild(element);

    const summary = createSummary(element, {
      textChange: { before: 'Draft', after: 'Saved' },
    });

    const snapshot = createApplyVerificationSnapshotFromSummaries([summary]);
    expect(snapshot).not.toBeNull();

    element.textContent = 'Different';

    const result = await verifyApplySnapshotSettled(snapshot!, { attempts: 1, settleDelayMs: 0 });
    expect(result.status).toBe('mismatch');
  });

  it('reports lost when the target can no longer be located', async () => {
    const element = document.createElement('div');
    element.id = 'target';
    element.textContent = 'Saved';
    document.body.appendChild(element);

    const summary = createSummary(element, {
      textChange: { before: 'Draft', after: 'Saved' },
    });

    const snapshot = createApplyVerificationSnapshotFromSummaries([summary]);
    expect(snapshot).not.toBeNull();

    element.remove();

    const result = await verifyApplySnapshotSettled(snapshot!, { attempts: 1, settleDelayMs: 0 });
    expect(result.status).toBe('lost');
  });

  it('keeps empty-text updates verifiable for single-transaction apply flows', async () => {
    const element = document.createElement('div');
    element.id = 'target';
    element.textContent = '';
    document.body.appendChild(element);

    const locator = createElementLocator(element);
    const tx: Transaction = {
      id: 'tx-1',
      type: 'text',
      targetLocator: locator,
      elementKey: 'target',
      before: { locator, text: 'Draft' },
      after: { locator, text: '' },
      timestamp: Date.now(),
      merged: false,
    };

    const snapshot = createApplyVerificationSnapshotFromTransaction(tx);
    expect(snapshot).not.toBeNull();

    const result = await verifyApplySnapshotSettled(snapshot!, { attempts: 1, settleDelayMs: 0 });
    expect(result.status).toBe('verified');
  });
});
