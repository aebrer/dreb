export function composerTextareaMaxHeight(innerHeightPx: number | undefined, narrow: boolean): number {
	const viewportHeight = innerHeightPx || 800;
	return Math.max(120, Math.floor(viewportHeight * (narrow ? 0.26 : 0.4)));
}
