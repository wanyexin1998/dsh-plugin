/**
 * Command registry for the palette (SQL-213).
 *
 * Plain data plus one pure filter, so the palette component stays a dumb list
 * and the panel decides what "run" means for each action.
 */

/** One command the palette can run. */
export interface CommandAction {
  /** Stable id, also used by tests and future keybinding hints. */
  readonly id: string
  /** Label shown in the palette (Chinese, like the rest of the product). */
  readonly title: string
  /** Extra search words (English alias, shortcut, category). */
  readonly keywords?: string
  /** What running the command does. */
  readonly run: () => void
}

/** Lower-cased searchable text of one command. */
function haystack(action: CommandAction): string {
  return `${action.title} ${action.keywords ?? ''}`.toLowerCase()
}

/**
 * Filter commands for one query.
 *
 * Every whitespace-separated word must appear somewhere in the title or the
 * keywords (AND), and commands whose title starts with the first word rank
 * first; the rest keep registration order. `query` empty returns every command.
 *
 * @param actions - Registered commands, in display order.
 * @param query - What the user typed.
 */
export function filterCommands(actions: readonly CommandAction[], query: string): readonly CommandAction[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(word => word !== '')
  if (words.length === 0) return actions
  const scored: { action: CommandAction; score: number }[] = []
  for (const action of actions) {
    const text = haystack(action)
    if (!words.every(word => text.includes(word))) continue
    const first = words[0] as string
    const score = action.title.toLowerCase().startsWith(first) ? 0 : text.indexOf(first) + 1
    scored.push({ action, score })
  }
  return scored
    .map((entry, index) => ({ ...entry, index }))
    .sort((left, right) => left.score - right.score || left.index - right.index)
    .map(entry => entry.action)
}
