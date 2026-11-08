import type { RuntimeDirectorySelection } from "../../shared/protocol.js";
import { api } from "../api.js";

export function runtimeDirectoryReady(selection: RuntimeDirectorySelection): boolean {
	return selection.kind === "local" ? selection.cwd.trim().length > 0 : selection.projectId.length > 0;
}

/** Keep local callers compatible and IDs authoritative; never send the displayed host path for an ID. */
export function createRuntimeInDirectory(
	selection: string | RuntimeDirectorySelection,
	options: { sessionPath?: string; firstPrompt?: string } = {},
) {
	if (typeof selection === "string") return api.createRuntime(selection, options);
	return selection.kind === "local"
		? api.createRuntime(selection.cwd, options)
		: api.createProjectRuntime(selection.projectId, options);
}
