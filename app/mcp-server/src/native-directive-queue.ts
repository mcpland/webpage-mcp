export class NativeDirectiveQueueOverflowError extends Error {
  public constructor(public readonly maximumPending: number) {
    super(`Native directive queue exceeds the ${maximumPending}-message limit`);
    this.name = 'NativeDirectiveQueueOverflowError';
  }
}

/** A bounded, serial async queue for state-mutating native directives. */
export class NativeDirectiveQueue<T> {
  private readonly queue: T[] = [];
  private running = false;

  public constructor(
    private readonly maximumPending: number,
    private readonly handler: (item: T) => Promise<void>,
    private readonly onHandlerError: (error: unknown) => void,
  ) {
    if (!Number.isSafeInteger(maximumPending) || maximumPending <= 0) {
      throw new RangeError('maximumPending must be a positive safe integer');
    }
  }

  public get pendingCount(): number {
    return this.queue.length + (this.running ? 1 : 0);
  }

  public enqueue(item: T): void {
    if (this.pendingCount >= this.maximumPending) {
      throw new NativeDirectiveQueueOverflowError(this.maximumPending);
    }
    this.queue.push(item);
    this.drain();
  }

  private drain(): void {
    if (this.running) return;
    if (this.queue.length === 0) return;
    const next = this.queue.shift() as T;

    this.running = true;
    void this.handler(next)
      .catch((error) => {
        try {
          this.onHandlerError(error);
        } catch {
          // Error reporting must not stall the queue.
        }
      })
      .finally(() => {
        this.running = false;
        this.drain();
      });
  }
}
