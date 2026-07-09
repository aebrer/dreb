const MAX_COMPOSER_HISTORY = 100;

const composerHistory = new Map<string, string[]>();
// Per-session composer drafts — unsent text survives fleet→session navigation
// for as long as the tab lives. Keyed by runtime key.
const composerDrafts = new Map<string, string>();

export function getComposerDraft(key: string): string | undefined {
	return composerDrafts.get(key);
}

export function setComposerDraft(key: string, text: string): void {
	composerDrafts.set(key, text);
}

export function getComposerHistory(key: string): readonly string[] {
	return composerHistory.get(key) ?? [];
}

export function addComposerHistoryEntry(key: string, text: string): void {
	const history = composerHistory.get(key) ?? [];
	history.push(text);
	composerHistory.set(key, history.slice(-MAX_COMPOSER_HISTORY));
}

export function evictComposerMemory(key: string): void {
	composerHistory.delete(key);
	composerDrafts.delete(key);
}
