/**
 * Explicit concurrency gate.
 *
 * FIFO admission up to `maxConcurrency`. A write-capable child cannot overlap
 * another write-capable child in the same cwd unless `parallelWrites` is true.
 * Read-only children may run in parallel.
 */
export interface AcquireRequest {
  write: boolean;
  cwd: string;
  signal?: AbortSignal;
}

interface Waiter {
  request: AcquireRequest;
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  onAbort?: () => void;
}

interface Active {
  write: boolean;
  cwd: string;
}

export interface SchedulerOptions {
  maxConcurrency: number;
  parallelWrites: boolean;
}

export class Scheduler {
  readonly maxConcurrency: number;
  readonly parallelWrites: boolean;
  #active = new Map<number, Active>();
  #nextToken = 1;
  #queue: Waiter[] = [];

  constructor(options: SchedulerOptions) {
    this.maxConcurrency = Math.max(1, options.maxConcurrency);
    this.parallelWrites = options.parallelWrites;
  }

  get activeCount(): number {
    return this.#active.size;
  }

  get queuedCount(): number {
    return this.#queue.length;
  }

  acquire(request: AcquireRequest): Promise<() => void> {
    if (request.signal?.aborted) return Promise.reject(new Error("aborted"));
    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = { request, resolve, reject };
      if (request.signal) {
        waiter.onAbort = () => {
          const index = this.#queue.indexOf(waiter);
          if (index >= 0) this.#queue.splice(index, 1);
          reject(new Error("aborted"));
        };
        request.signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.#queue.push(waiter);
      this.#pump();
    });
  }

  /** Number of active write-capable children in one cwd. */
  writeCount(cwd: string): number {
    let count = 0;
    for (const entry of this.#active.values()) {
      if (entry.write && entry.cwd === cwd) count++;
    }
    return count;
  }

  #canAdmit(request: AcquireRequest): boolean {
    if (this.#active.size >= this.maxConcurrency) return false;
    if (!request.write || this.parallelWrites) return true;
    return this.writeCount(request.cwd) === 0;
  }

  #pump(): void {
    for (let index = 0; index < this.#queue.length; ) {
      const waiter = this.#queue[index];
      if (!waiter) break;
      if (!this.#canAdmit(waiter.request)) {
        index++;
        continue;
      }
      this.#queue.splice(index, 1);
      if (waiter.onAbort) waiter.request.signal?.removeEventListener("abort", waiter.onAbort);
      const token = this.#nextToken++;
      this.#active.set(token, { write: waiter.request.write, cwd: waiter.request.cwd });
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        this.#active.delete(token);
        this.#pump();
      });
    }
  }
}
