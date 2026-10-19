/**
 * Identity of the SQL workbench page type inside the right sidebar.
 *
 * `TAB_ID` doubles as the keyed seat key: the right column dispatches a tab body
 * by its definition's `id` (`packages/client/ui-sidebar-right/src/client/shell/SidebarRight.tsx`),
 * so the body and title registrations below must carry exactly this value.
 */

/** Cordis locale namespace for this plugin's copy. */
export const TAB_NS = 'dsh-data-ide.tab'

/** Implementation identity and keyed seat key. */
export const TAB_ID = 'dsh-data-ide.sql-workbench'

/** Page-type discriminator `openTab` names. */
export const TAB_KIND = TAB_ID

/** Slot names declared by `ui-sidebar-right` under `rightbar.session`. */
export const TAB_BODY_SLOT = 'sidebar.right.pane.tab'
export const TAB_TITLE_SLOT = 'sidebar.right.pane.tab.title'
