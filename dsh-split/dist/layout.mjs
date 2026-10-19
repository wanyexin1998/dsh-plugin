// src/layout.ts
function emptyLayout() {
  return { panels: [], focusedId: null, nonce: 0 };
}
function focusOf(state) {
  if (state.panels.length === 0) return null;
  if (state.focusedId !== null && state.panels.some((panel) => panel.id === state.focusedId)) return state.focusedId;
  return state.panels[0].id;
}
function mintId(state, sessionId) {
  const nonce = state.nonce + 1;
  return { id: "panel-" + sessionId + "-" + nonce, nonce };
}
function panelOfSession(state, sessionId) {
  return state.panels.find((panel) => panel.sessionId === sessionId) ?? null;
}
function place(state, sessionId, options = {}) {
  const existing = panelOfSession(state, sessionId);
  if (existing !== null) return { state: { ...state, focusedId: existing.id }, id: existing.id, created: false };
  const minted = mintId(state, sessionId);
  const record = { id: minted.id, sessionId };
  const index = options.at === void 0 ? state.panels.length : Math.max(0, Math.min(options.at, state.panels.length));
  const panels = [...state.panels.slice(0, index), record, ...state.panels.slice(index)];
  return { state: { panels, focusedId: record.id, nonce: minted.nonce }, id: record.id, created: true };
}
function close(state, id) {
  const index = state.panels.findIndex((panel) => panel.id === id);
  if (index === -1) return { state, focus: focusOf(state) };
  const panels = state.panels.filter((panel) => panel.id !== id);
  const next = panels.length === 0 ? null : panels[Math.min(index, panels.length - 1)].id;
  return { state: { ...state, panels, focusedId: next }, focus: next };
}
function focus(state, id) {
  if (!state.panels.some((panel) => panel.id === id)) return state;
  return { ...state, focusedId: id };
}
function cycle(state, step) {
  const count = state.panels.length;
  if (count === 0) return state;
  const current = focusOf(state);
  const index = current === null ? -1 : state.panels.findIndex((panel) => panel.id === current);
  const next = ((index + step) % count + count) % count;
  return { ...state, focusedId: state.panels[next].id };
}
function move(state, id, toIndex) {
  const from = state.panels.findIndex((panel) => panel.id === id);
  if (from === -1) return state;
  const clamped = Math.max(0, Math.min(toIndex, state.panels.length - 1));
  if (from === clamped) return state;
  const panels = [...state.panels];
  const [moved] = panels.splice(from, 1);
  panels.splice(clamped, 0, moved);
  return { ...state, panels };
}
function reveal(state, sessionId) {
  const existing = panelOfSession(state, sessionId);
  return existing === null ? state : focus(state, existing.id);
}
function serialize(state) {
  return { schemaVersion: 1, panels: state.panels.map((panel) => ({ id: panel.id, sessionId: panel.sessionId })), focusedId: focusOf(state) };
}
function deserialize(raw) {
  if (raw === null || typeof raw !== "object") return emptyLayout();
  const candidate = raw;
  if (candidate.schemaVersion !== 1) return emptyLayout();
  if (!Array.isArray(candidate.panels)) return emptyLayout();
  const seenSessions = /* @__PURE__ */ new Set();
  const seenIds = /* @__PURE__ */ new Set();
  const panels = [];
  for (const entry of candidate.panels) {
    if (entry === null || typeof entry !== "object") continue;
    const record = entry;
    if (typeof record.id !== "string" || record.id === "" || typeof record.sessionId !== "string" || record.sessionId === "") continue;
    if (seenIds.has(record.id) || seenSessions.has(record.sessionId)) continue;
    seenIds.add(record.id);
    seenSessions.add(record.sessionId);
    panels.push({ id: record.id, sessionId: record.sessionId });
  }
  const focusedId = typeof candidate.focusedId === "string" && seenIds.has(candidate.focusedId) ? candidate.focusedId : null;
  const nonce = typeof candidate.nonce === "number" && Number.isFinite(candidate.nonce) ? candidate.nonce : panels.length;
  return { panels, focusedId, nonce: Math.max(nonce, panels.length) };
}
export {
  close,
  cycle,
  deserialize,
  emptyLayout,
  focus,
  focusOf,
  move,
  place,
  reveal,
  serialize
};
