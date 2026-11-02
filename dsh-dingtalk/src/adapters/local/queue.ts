import { ConnectionServiceError } from '../../shared/models.js';
import type { ExecutionLimits } from '../../shared/config.js';

interface Pending { start(): void; cancel(reason: 'execution_cancelled' | 'queue_timeout'): void }
/** One running operation per bound backend; no concurrent token refreshes from this owner. */
export class ExecutionQueue {
  private running = false;
  private closed = false;
  private pending: Pending[] = [];
  private active: AbortController | undefined;
  private settled: Promise<unknown> = Promise.resolve();
  constructor(private readonly limits: ExecutionLimits) {}
  run<T>(action: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.closed || signal?.aborted) return Promise.reject(new ConnectionServiceError('execution_cancelled'));
    if (this.running && this.pending.length >= this.limits.queueLimit) return Promise.reject(new ConnectionServiceError('queue_full'));
    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let started = false;
      const controller = new AbortController();
      const remove = (): void => { clearTimeout(timer); signal?.removeEventListener('abort', abort); this.pending = this.pending.filter(entry => entry !== entryRef); };
      const abort = (): void => { if (started) controller.abort(); else entryRef.cancel('execution_cancelled'); };
      const entryRef: Pending = {
        start: () => {
          remove(); started = true; this.running = true; this.active = controller;
          const deadline = setTimeout(() => controller.abort('execution_timeout'), this.limits.timeoutMs);
          signal?.addEventListener('abort', abort, { once: true });
          if (signal?.aborted || this.closed) controller.abort();
          const finish = (): void => {
            clearTimeout(deadline);
            signal?.removeEventListener('abort', abort);
            this.running = false; this.active = undefined;
            this.pending.shift()?.start();
          };
          this.settled = Promise.resolve().then(() => action(controller.signal)).then(
            value => { finish(); resolve(value); }, error => { finish(); reject(error); });
        },
        cancel: reason => { remove(); reject(new ConnectionServiceError(reason)); },
      };
      signal?.addEventListener('abort', abort, { once: true });
      if (this.running) {
        this.pending.push(entryRef);
        timer = setTimeout(() => entryRef.cancel('queue_timeout'), this.limits.queueTimeoutMs);
      } else entryRef.start();
    });
  }
  async dispose(): Promise<void> {
    this.closed = true;
    for (const entry of [...this.pending]) entry.cancel('execution_cancelled');
    this.active?.abort();
    await this.settled;
  }
}
