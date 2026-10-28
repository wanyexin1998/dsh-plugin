/**
 * Draft edits go through the host input actions.
 * captureInsertion lives on those actions. A missing span is a failure,
 * never a synthetic {start:0,end:0}. setDraft replaces the whole draft, so
 * continuing a task uses insertText.
 */

export interface DraftSpan {
  start: number
  end: number
  draftRev?: number
}

export interface DraftActions {
  captureInsertion?: () => DraftSpan | null | undefined
  insertReference?: (reference: unknown, span: DraftSpan) => boolean
  insertText?: (text: string, span?: DraftSpan | null) => boolean
  setDraft?: (text: string) => boolean
}

export function resolveDraftActions(facade: { actions?: DraftActions; captureInsertion?: DraftActions['captureInsertion'] } | null | undefined): DraftActions | null {
  if (facade?.actions && typeof facade.actions.captureInsertion === 'function') return facade.actions
  if (facade && typeof facade.captureInsertion === 'function') return facade as DraftActions
  return null
}

export function insertSessionReference(actions: DraftActions | null, input: { mention: string; label: string }): boolean {
  if (!actions || typeof actions.captureInsertion !== 'function' || typeof actions.insertReference !== 'function') return false
  const span = actions.captureInsertion()
  if (!span || typeof span.start !== 'number' || typeof span.end !== 'number') return false
  return actions.insertReference({
    source: 'reference',
    ref: input.mention,
    label: input.label,
    appearance: 'session',
    clipboardText: input.mention,
  }, span) === true
}

export function insertDraftText(actions: DraftActions | null, text: string): boolean {
  if (!actions || typeof actions.insertText !== 'function') return false
  const span = typeof actions.captureInsertion === 'function' ? actions.captureInsertion() : undefined
  return actions.insertText(text, span ?? undefined) !== false
}
