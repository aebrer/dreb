/** Resolve an explicitly registered project without credentials, provider calls or agent execution. */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CloudWorkspaceRegistry } from "@dreb/coding-agent";

export async function resolveRegisteredProject(projectId: string, agentDir?: string): Promise<string> {
	return new CloudWorkspaceRegistry({ agentDir }).resolve(projectId);
}

// Run with: npx tsx examples/sdk/13-cloud-workspaces.ts <full-project-uuid>
// DREB_CODING_AGENT_DIR selects this device's registry, as it does for the CLI.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const projectId = process.argv[2];
	if (!projectId || process.argv.length !== 3) {
		console.error("Usage: 13-cloud-workspaces.ts <full-project-uuid>");
		process.exitCode = 1;
	} else {
		try {
			console.log(await resolveRegisteredProject(projectId));
		} catch (error) {
			console.error(error instanceof Error ? error.message : String(error));
			process.exitCode = 1;
		}
	}
}
