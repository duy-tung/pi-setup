/** One extension instance/session owns these promises, not a loader-global registry.
 * Track backend jobs only: waiting for a UI dialog during shutdown can deadlock. */
export interface BackendLifetime {
  readonly hostManaged: boolean;
  readonly queued: AbortController;
  readonly pending: Set<Promise<unknown>>;
  closed: boolean;
}

export function createBackendLifetime(hostManaged = false): BackendLifetime {
  return { hostManaged, queued: new AbortController(), pending: new Set(), closed: false };
}

export function closeBackend(lifetime: BackendLifetime): void {
  if (lifetime.closed) return;
  lifetime.closed = true;
  lifetime.queued.abort(new Error("Rewind session is closing"));
}

/** Compensation (retiring an unpublished ref after a failed accepted job) is
 * part of that job: it is admitted after close and still drained. */
export function runBackend<T>(lifetime: BackendLifetime | undefined, operation: () => T | Promise<T>, opts: { compensating?: boolean } = {}): Promise<T> {
  if (lifetime?.closed && !opts.compensating) return Promise.reject(new Error("Rewind session is closing"));
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const result = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  // Register before invoking the job, including synchronous/re-entrant starts.
  lifetime?.pending.add(result);
  const finished = () => { lifetime?.pending.delete(result); };
  void result.then(finished, finished);
  try { resolve(operation()); } catch (error) { reject(error); }
  return result;
}

/** No arbitrary timeout: a still-running writer is not a released writer.
 * Admission is closed first; jobs already holding a lock may finish their writes. */
export async function drainBackend(lifetime: BackendLifetime): Promise<void> {
  while (lifetime.pending.size) await Promise.allSettled([...lifetime.pending]);
}
