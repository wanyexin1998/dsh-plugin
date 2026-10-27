/** User-facing write-mode fact. The blocked list comes from the host ledger when it is present. */
export function writeModeClosed(blockedByGates?: readonly string[]): string {
  if (blockedByGates && blockedByGates.length > 0) {
    return `关闭（blockedBy: ${blockedByGates.join(', ')}）`
  }
  return '关闭（G01–G06 与 G08、G09 通过前）'
}
