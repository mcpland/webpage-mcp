import { beforeEach, describe, expect, it } from 'vitest';

import {
  createDomTraversalBudget,
  findElementInsertionReference,
  findUniqueElement,
} from '@/entrypoints/web-editor/core/dom-traversal';
import { createTransactionManager } from '@/entrypoints/web-editor/core/transaction-manager';

describe('web editor DOM traversal resource limits', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('stops uniqueness matching as soon as a second element is found', () => {
    const root = document.createElement('div');
    root.innerHTML = '<span class="match"></span><span class="match"></span><i></i>';
    const budget = createDomTraversalBudget({ maxElements: 3, maxTraversalMs: 1_000 });

    expect(findUniqueElement(root, '.match', budget)).toBeNull();
    expect(budget.remainingElements).toBe(1);
  });

  it('fails closed when uniqueness cannot be proven within the element budget', () => {
    const root = document.createElement('div');
    root.innerHTML = '<span class="match"></span><i></i><b></b>';

    expect(
      findUniqueElement(
        root,
        '.match',
        createDomTraversalBudget({ maxElements: 2, maxTraversalMs: 1_000 }),
      ),
    ).toBeNull();
    expect(
      findUniqueElement(
        root,
        '.match',
        createDomTraversalBudget({ maxElements: 3, maxTraversalMs: 1_000 }),
      ),
    ).toBe(root.firstElementChild);
  });

  it('fails closed when a selector walk reaches the maximum DOM depth', () => {
    const root = document.createElement('div');
    let parent = root;
    for (let depth = 0; depth < 129; depth++) {
      const child = document.createElement('div');
      parent.append(child);
      parent = child;
    }
    parent.className = 'deep-target';

    expect(findUniqueElement(root, '.deep-target')).toBeNull();
  });

  it('reports an incomplete insertion lookup instead of snapshotting excess children', () => {
    const parent = document.createElement('div');
    parent.append(
      document.createElement('span'),
      document.createElement('span'),
      document.createElement('span'),
    );

    expect(findElementInsertionReference(parent, 3, undefined, 2)).toEqual({
      complete: false,
      reference: null,
    });
  });

  it('strips ids from a duplicated subtree without a selector snapshot', () => {
    const target = document.createElement('section');
    target.id = 'source';
    target.innerHTML = '<div id="child"><span id="grandchild"></span></div>';
    document.body.append(target);

    const manager = createTransactionManager();
    const transaction = manager.applyStructure(target, { action: 'duplicate' });
    const clone = target.nextElementSibling;

    expect(transaction).not.toBeNull();
    expect(clone).toBeInstanceOf(Element);
    expect(clone?.hasAttribute('id')).toBe(false);
    expect(clone?.firstElementChild?.hasAttribute('id')).toBe(false);
    expect(clone?.firstElementChild?.firstElementChild?.hasAttribute('id')).toBe(false);
    manager.dispose();
  });
});
