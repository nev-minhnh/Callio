// Start-up after Callio was closed unexpectedly (power cut, crash, Windows restarting): features
// register what they can bring back; when the last run did not end cleanly, Callio asks once
// "Reopen the previous session?" and, on yes, calls each one's restore().
// (The dialog, the clean-exit marker and unsaved drafts are the chat-ui feature's; others only
// register here.)
const restorers = new Map();

/**
 * @param {{id: string, order?: number, describe: () => Promise<string|null>|string|null,
 *          restore: () => Promise<void>|void, discard?: () => Promise<void>|void}} r
 *   describe(): one short line for the dialog ("2 Claude Code sessions"), or null if nothing.
 */
export function registerRestorer(r) { restorers.set(r.id, r); }
export function restorersList() { return [...restorers.values()].sort((a, b) => (a.order ?? 50) - (b.order ?? 50)); }
