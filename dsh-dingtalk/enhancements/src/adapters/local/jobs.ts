import { randomUUID } from 'node:crypto';
import { ConnectionServiceError } from '../../shared/models.js';
import type { JsonValue } from '../../shared/models.js';
import { redactData } from './redaction.js';

interface Job { id: string; owner: string; command: string; state: string; controller: AbortController; next: number; records: { cursor: number; data: JsonValue }[]; done: Promise<void>; reason?: string }
export class CommandJobs {
  private entries = new Map<string, Job>();
  private closed = false;
  start(owner: string | undefined, command: string, execute: (signal: AbortSignal, emit: (data: unknown) => void) => Promise<unknown>): JsonValue {
    if (!owner || this.closed) throw new ConnectionServiceError('invalid_request');
    if ([...this.entries.values()].filter(j => j.state === 'running').length >= 4) throw new ConnectionServiceError('job_limit');
    if (this.entries.size >= 32) { const old = [...this.entries.values()].find(j => j.state !== 'running'); if (old) this.entries.delete(old.id); }
    const job: Job = { id: randomUUID(), owner, command, state: 'running', controller: new AbortController(), next: 0, records: [], done: Promise.resolve() };
    this.entries.set(job.id, job);
    job.done = Promise.resolve().then(() => { if (job.controller.signal.aborted) throw new ConnectionServiceError('execution_cancelled'); return execute(job.controller.signal, data => {
      if (data && typeof data === 'object' && ('success' in data && data.success === false || 'isError' in data && data.isError === true)) throw new ConnectionServiceError('cli_failed');
      const cleaned = redactData(data);
      job.records.push({ cursor: job.next++, data: JSON.stringify(cleaned).length > 24000 ? { truncated: true, note: 'Event exceeds retained output limit; query the resource directly for full content.' } : cleaned });
      if (job.records.length > 100) job.records.shift();
    }); }).then(() => { job.state = job.controller.signal.aborted ? 'stopped' : 'completed'; }, error => { job.state = job.controller.signal.aborted ? 'stopped' : 'failed'; job.reason = error instanceof ConnectionServiceError ? error.reasonCode : 'service_unavailable'; });
    return { jobId: job.id, command, state: job.state, next: 'Use dws.jobs read to retrieve output, or stop to end the task.' };
  }
  async access(owner: string | undefined, args: { action: 'list' | 'read' | 'stop'; jobId?: string; cursor?: number }): Promise<JsonValue> {
    if (!owner) throw new ConnectionServiceError('invalid_request');
    if (args.action === 'list') return { jobs: [...this.entries.values()].filter(j => j.owner === owner).map(j => ({ jobId: j.id, command: j.command, state: j.state })) };
    const job = this.entries.get(args.jobId || '');
    if (!job || job.owner !== owner) throw new ConnectionServiceError('job_not_found');
    if (args.action === 'stop') { job.controller.abort(); await job.done; }
    const cursor = args.cursor || 0, records = job.records.filter(r => r.cursor >= cursor).slice(0, 10);
    return { jobId: job.id, state: job.state, ...(job.reason ? { reason: job.reason } : {}), truncated: job.records.length > 0 && cursor < job.records[0]!.cursor, records, nextCursor: records.length ? records[records.length - 1]!.cursor + 1 : job.next };
  }
  async dispose() { this.closed = true; for (const j of this.entries.values()) j.controller.abort(); await Promise.all([...this.entries.values()].map(j => j.done)); this.entries.clear(); }
}
