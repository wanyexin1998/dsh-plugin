/**
 * Main-session conversation skin (FE-01 / FE-12).
 *
 * Every rule is rooted at `[data-boop-chat]`, which the main-Session header
 * stamps on the native `[data-conversation-content]` for that Session only.
 * Send, attachments, and TurnNavigator stay the host's. Model and permission
 * pickers are hidden here and surfaced in the right Sidebar; this sheet only
 * retokens bubbles and the composer card.
 *
 * Native anchors (do not match hashed `.dsw-*` classes):
 *  - user/steering text lives on `[data-message-bubble]`
 *  - the composer stays the host InputBar. The outer corner is one fixed
 *    28px radius: a 52px single line reads as a capsule, a taller draft keeps
 *    the same corners and drops + / voice / send onto the bottom row. The
 *    editor and send path are not replaced.
 *  - send uses `--dsw-alias-button-info-fill`
 *  - voice lives in `conversation.input.activity`; do not hide it
 */
const TOKENS = `
  --boop-blue: #449BCC;
  --boop-deep: #073F5C;
  --boop-ink: #0B2637;
  --boop-interactive: #17648B;
  --boop-soft: #EAF5FB;
  --boop-user: #d7eef6;
  --boop-muted: #f3f1ea;
  --boop-pearl: #f8f7f2;
  --boop-line: rgba(11, 38, 55, 0.16);
  --dsw-specific-bubble: var(--boop-user);
  --dsw-specific-input-major: #ffffff;
  --dsw-elevation-stroke-color: var(--boop-line);
  --dsw-specific-selector: var(--boop-soft);
  --dsw-alias-state-business-primary: var(--boop-interactive);
  --dsw-alias-button-info-fill: var(--boop-interactive);
  --dsw-alias-button-info-hover: #3b8fb8;
  --dsw-static-deepseek-500: var(--boop-interactive);
  --dsw-static-deepseek-400: #3b8fb8;
`

const DARK_TOKENS = `
  --boop-ink: #EAF5FB;
  --boop-soft: rgba(68, 155, 204, 0.14);
  --boop-user: rgba(68, 155, 204, 0.32);
  --boop-muted: rgba(248, 247, 242, 0.08);
  --boop-pearl: #0B2637;
  --boop-line: rgba(234, 245, 251, 0.28);
  --dsw-specific-bubble: var(--boop-user);
  --dsw-specific-input-major: rgba(11, 38, 55, 0.86);
  --dsw-specific-selector: rgba(68, 155, 204, 0.18);
  --dsw-alias-button-info-fill: #3b8fb8;
  --dsw-alias-button-info-hover: #449BCC;
`

export const BOOP_CHAT_CSS = `
[data-boop-chat] {
${TOKENS}
  --dsh-chat-flow-gap: 14px;
  --dsh-composer-text-max-height: 240px;
  color: var(--boop-ink);
  background:
    radial-gradient(900px 280px at 50% -40px, rgba(173, 221, 235, 0.55), transparent 70%);
}
body[data-ds-dark-theme] [data-boop-chat] {
${DARK_TOKENS}
  background:
    radial-gradient(900px 280px at 50% -40px, rgba(7, 63, 92, 0.55), transparent 70%);
}

[data-boop-chat] [data-chat-flow-kind="user"] [data-message-bubble],
[data-boop-chat] [data-chat-flow-kind="steering"] [data-message-bubble] {
  border-radius: 16px;
  background: linear-gradient(#e7f6fb, var(--boop-user));
  color: var(--boop-deep);
}
body[data-ds-dark-theme] [data-boop-chat] [data-chat-flow-kind="user"] [data-message-bubble],
body[data-ds-dark-theme] [data-boop-chat] [data-chat-flow-kind="steering"] [data-message-bubble] {
  background: var(--boop-user);
  color: var(--boop-ink);
}

[data-boop-chat] [data-chat-flow-kind="assistant-step"][data-chat-group-part="response"] {
  align-self: flex-start;
  box-sizing: border-box;
  width: fit-content;
  max-width: 100%;
  border-radius: 16px;
  padding: 10px 14px;
  background: var(--boop-muted);
}

/* One 28px corner. At 52px tall the ends read as a capsule; taller, the sides stay straight. */
[data-boop-chat] [data-composer-card] {
  --dsw-radius-panel: 28px;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  align-items: center;
  min-height: 52px;
  padding: 6px 8px;
  border: 1px solid rgba(11, 38, 55, 0.12);
  border-radius: 28px;
  background: #ffffff;
  box-shadow:
    0 1px 0 rgba(0, 0, 0, 0.04),
    0 6px 8px -6px rgba(7, 63, 92, 0.08);
}
body[data-ds-dark-theme] [data-boop-chat] [data-composer-card] {
  border-color: rgba(234, 245, 251, 0.28);
  background: rgba(11, 38, 55, 0.86);
  box-shadow:
    0 1px 0 rgba(0, 0, 0, 0.24),
    0 6px 8px -6px rgba(0, 0, 0, 0.5);
}
[data-boop-chat] [data-composer-card] > [data-input-scroll] {
  grid-column: 1;
  grid-row: 1;
  min-width: 0;
}
[data-boop-chat] [data-composer-card] > :last-child {
  grid-column: 1;
  grid-row: 1;
  z-index: 1;
  display: flex;
  flex-wrap: nowrap;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  padding: 0;
  min-width: 0;
  pointer-events: none;
}
[data-boop-chat] [data-composer-card] > :last-child * {
  pointer-events: auto;
}
[data-boop-chat] [data-composer-card] > [data-slot] {
  grid-column: 1;
}
[data-boop-chat] [data-composer-input] {
  box-sizing: border-box;
  padding: 4px 80px 0 44px;
  font-size: 15px;
  font-weight: 450;
  line-height: 1.5;
}
[data-boop-chat] [data-composer-placeholder] {
  left: 44px;
  right: 80px;
}

/* Multiline only moves the toolbar under the text. The 28px corner stays. */
[data-boop-chat] [data-composer-card][data-boop-multiline] {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 8px;
  min-height: 0;
  padding: 12px 14px 10px;
}
[data-boop-chat] [data-composer-card][data-boop-multiline] > [data-input-scroll] {
  grid-column: auto;
  grid-row: auto;
  min-width: 0;
}
[data-boop-chat] [data-composer-card][data-boop-multiline] > :last-child {
  grid-column: auto;
  grid-row: auto;
  z-index: auto;
  width: 100%;
  pointer-events: auto;
  justify-content: space-between;
}
[data-boop-chat] [data-composer-card][data-boop-multiline] [data-composer-input] {
  padding: 4px 8px 0 4px;
}
[data-boop-chat] [data-composer-card][data-boop-multiline] [data-composer-placeholder] {
  left: 12px;
  right: 12px;
}

/* Model / permission / plan move to the Sidebar. Voice stays. */
[data-boop-chat] :is(
  [data-slot="conversation.input.model"],
  [data-slot="conversation.input.plan"],
  [data-slot="conversation.input.permission"]
) {
  display: none !important;
}
[data-boop-chat] [data-composer-dock] {
  display: none;
}

@media (prefers-reduced-motion: reduce) {
  [data-boop-chat],
  [data-boop-chat] * {
    transition: none !important;
    animation: none !important;
  }
}
`
