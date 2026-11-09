import { CloudSessionStorage } from "../../src/core/cloud-workspaces/session-storage.js";

const [agentDir, root] = process.argv.slice(2);
if (!agentDir || !root) throw new Error("Expected an isolated agent directory and session storage root.");

const status = await new CloudSessionStorage({ agentDir }).setRoot(root, {
	sessionDir: null,
	subagentSessionDir: null,
});
process.stdout.write(`${JSON.stringify(status)}\n`);
