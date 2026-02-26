/**
 * @fileoverview Mock for hnswlib-wasm-static
 * @description Provides a stub for vector database in test environment
 */

export const HierarchicalNSW = class MockHierarchicalNSW {
  constructor() {}
  initIndex() {}
  addPoint() {}
  searchKnn() {
    return { neighbors: [], distances: [] };
  }
  getCurrentCount() {
    return 0;
  }
  resizeIndex() {}
  getPoint() {
    return [];
  }
  markDelete() {}
};

export default { HierarchicalNSW };
