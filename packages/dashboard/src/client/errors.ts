/** Shared client-side error classifiers. */

export function isAbortError(error: unknown): boolean {
	if (typeof DOMException !== "undefined" && error instanceof DOMException && error.name === "AbortError") return true;
	return (
		typeof error === "object" &&
		error !== null &&
		"name" in error &&
		(error as { name?: unknown }).name === "AbortError"
	);
}
