import type { ReasonCode } from '../shared/models.js';

/** One mounted authorization prompt per conversation, regardless of Tool retries. */
export class PromptRegistry {
  private scopes = new Map<string, Map<string, { references: number; reason: ReasonCode; revision: number }>>();
  private listeners = new Set<() => void>();
  private version = 0;
  constructor(private revision: () => number) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.version;
  private publish() { this.version++; for (const listener of this.listeners) listener(); }
  register(scope: string, call: string, reason: ReasonCode) {
    let entries = this.scopes.get(scope);
    if (!entries) { entries = new Map(); this.scopes.set(scope, entries); }
    const previous = entries.get(call);
    entries.set(call, { references: (previous?.references || 0) + 1, reason, revision: this.revision() });
    this.publish();
    return () => {
      const entry = entries!.get(call);
      if (!entry) return;
      if (--entry.references === 0) entries!.delete(call);
      if (!entries!.size) this.scopes.delete(scope);
      this.publish();
    };
  }
  get(scope: string) {
    const entries = this.scopes.get(scope);
    const latest = [...(entries?.values() || [])].filter(entry => entry.revision === this.revision()).at(-1);
    return { owner: entries?.keys().next().value as string | undefined, reason: latest?.reason };
  }
  dispose() { this.scopes.clear(); this.listeners.clear(); }
}
