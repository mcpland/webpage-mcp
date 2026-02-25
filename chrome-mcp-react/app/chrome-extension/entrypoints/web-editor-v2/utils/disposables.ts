/**
 * Disposables Utility
 *
 * Provides deterministic cleanup for event listeners, observers, and other resources.
 * Ensures proper cleanup order (LIFO) and prevents memory leaks.
 */

/** Function that performs cleanup */
export type DisposeFn = () => void;

/**
 * Manages a collection of disposable resources.
 * Resources are disposed in reverse order (LIFO).
 */
export class Disposer {
  private disposed = false;
  private readonly disposers: DisposeFn[] = [];

  /** Whether this disposer has already been disposed */
  get isDisposed(): boolean {
    return this.disposed;
  }

  /**
   * Add a dispose function to be called during cleanup.
   * If already disposed, the function is called immediately.
   */
  add(dispose: DisposeFn): void {
    if (this.disposed) {
      try {
        dispose();
      } catch {
        // Best-effort cleanup for late additions
      }
      return;
    }
    this.disposers.push(dispose);
  }

  /**
   * Add an event listener and automatically remove it on dispose.
   */
  listen<K extends keyof WindowEventMap>(
    target: Window,
    type: K,
    listener: (ev: WindowEventMap[K]) => void,
    options?: boolean | AddEventListenerOptions,
  ): void;
  listen<K extends keyof DocumentEventMap>(
    target: Document,
    type: K,
    listener: (ev: DocumentEventMap[K]) => void,
    options?: boolean | AddEventListenerOptions,
  ): void;
  listen<K extends keyof HTMLElementEventMap>(
    target: HTMLElement,
    type: K,
    listener: (ev: HTMLElementEventMap[K]) => void,
    options?: boolean | AddEventListenerOptions,
  ): void;
  listen(
    target: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void;
  listen(
    target: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void {
    target.addEventListener(type, listener, options);
    this.add(() => target.removeEventListener(type, listener, options));
  }

  /**
   * Add a ResizeObserver and automatically disconnect it on dispose.
   */
  observeResize(
    target: Element,
    callback: ResizeObserverCallback,
    options?: ResizeObserverOptions,
  ): ResizeObserver {
    const observer = new ResizeObserver(callback);
    observer.observe(target, options);
    this.add(() => observer.disconnect());
    return observer;
  }

  /**
   * Add a MutationObserver and automatically disconnect it on dispose.
   */
  observeMutation(
    target: Node,
    callback: MutationCallback,
    options?: MutationObserverInit,
  ): MutationObserver {
    const observer = new MutationObserver(callback);
    observer.observe(target, options);
    this.add(() => observer.disconnect());
    return observer;
  }

  /**
   * Add a requestAnimationFrame and automatically cancel it on dispose.
   * Returns a function to manually cancel the frame.
   */
  requestAnimationFrame(callback: FrameRequestCallback): () => void {
    const id = requestAnimationFrame(callback);
    let cancelled = false;

    const cancel = () => {
      if (cancelled) return;
      cancelled = true;
      cancelAnimationFrame(id);
    };

    this.add(cancel);
    return cancel;
  }

  /**
   * Dispose all registered resources in reverse order.
   * Safe to call multiple times.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    // Dispose in reverse order (LIFO)
    for (let i = this.disposers.length - 1; i >= 0; i--) {
      try {
        this.disposers[i]();
      } catch {
        // Best-effort cleanup, continue with remaining disposers
      }
    }

    this.disposers.length = 0;
  }
}
