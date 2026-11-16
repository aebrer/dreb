import { CloudWorkspaceRegistry } from "../../src/core/cloud-workspaces/registry.js";

const [agentDir, directory, projectId] = process.argv.slice(2);
if (!agentDir || !directory || !projectId) {
	throw new Error("Usage: cloud-workspace-writer.ts <agentDir> <directory> <projectId>");
}

await new CloudWorkspaceRegistry({ agentDir }).link(directory, { projectId });
