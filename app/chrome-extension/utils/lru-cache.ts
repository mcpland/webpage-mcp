class LRUNode<K, V> {
  constructor(
    public key: K,
    public value: V,
    public prev: LRUNode<K, V> | null = null,
    public next: LRUNode<K, V> | null = null,
    public frequency: number = 1,
    public lastAccessed: number = Date.now(),
  ) {}
}

class LRUCache<K = string, V = any> {
  private capacity: number;
  private cache: Map<K, LRUNode<K, V>>;
  private head: LRUNode<K, V>;
  private tail: LRUNode<K, V>;

  constructor(capacity: number) {
    this.capacity = capacity > 0 ? capacity : 100;
    this.cache = new Map<K, LRUNode<K, V>>();

    this.head = new LRUNode<K, V>(null as any, null as any);
    this.tail = new LRUNode<K, V>(null as any, null as any);
    this.head.next = this.tail;
    this.tail.prev = this.head;
  }

  private addToHead(node: LRUNode<K, V>): void {
    node.prev = this.head;
    node.next = this.head.next;
    this.head.next!.prev = node;
    this.head.next = node;
  }

  private removeNode(node: LRUNode<K, V>): void {
    node.prev!.next = node.next;
    node.next!.prev = node.prev;
  }

  private moveToHead(node: LRUNode<K, V>): void {
    this.removeNode(node);
    this.addToHead(node);
  }

  private findVictimNode(): LRUNode<K, V> {
    let victim = this.tail.prev!;
    let minScore = this.calculateEvictionScore(victim);

    let current = this.tail.prev;
    let count = 0;
    const maxCheck = Math.min(5, this.cache.size);

    while (current && current !== this.head && count < maxCheck) {
      const score = this.calculateEvictionScore(current);
      if (score < minScore) {
        minScore = score;
        victim = current;
      }
      current = current.prev;
      count++;
    }

    return victim;
  }

  private calculateEvictionScore(node: LRUNode<K, V>): number {
    const now = Date.now();
    const timeSinceAccess = now - node.lastAccessed;
    const timeWeight = 1 / (1 + timeSinceAccess / (1000 * 60));
    const frequencyWeight = Math.log(node.frequency + 1);

    return frequencyWeight * timeWeight;
  }

  get(key: K): V | null {
    const node = this.cache.get(key);
    if (node) {
      node.frequency++;
      node.lastAccessed = Date.now();
      this.moveToHead(node);
      return node.value;
    }
    return null;
  }

  set(key: K, value: V): void {
    const existingNode = this.cache.get(key);

    if (existingNode) {
      existingNode.value = value;
      this.moveToHead(existingNode);
    } else {
      const newNode = new LRUNode(key, value);

      if (this.cache.size >= this.capacity) {
        const victimNode = this.findVictimNode();
        this.removeNode(victimNode);
        this.cache.delete(victimNode.key);
      }

      this.cache.set(key, newNode);
      this.addToHead(newNode);
    }
  }

  has(key: K): boolean {
    return this.cache.has(key);
  }

  clear(): void {
    this.cache.clear();
    this.head.next = this.tail;
    this.tail.prev = this.head;
  }

  get size(): number {
    return this.cache.size;
  }

  /**
   * Get cache statistics
   */
  getStats(): { size: number; capacity: number; usage: number } {
    return {
      size: this.cache.size,
      capacity: this.capacity,
      usage: this.cache.size / this.capacity,
    };
  }
}

export default LRUCache;
