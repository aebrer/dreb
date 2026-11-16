import { isAbsolute, win32 } from "node:path";
import { APP_NAME, resolveDirectoryPath } from "../config.js";
import { CloudWorkspaceRegistry } from "../core/cloud-workspaces/registry.js";
import {
	type CloudProjectLocation,
	CloudWorkspaceError,
	type CloudWorkspaceState,
	type CloudWorkspaceStatus,
	cloudId,
} from "../core/cloud-workspaces/types.js";

const COMMANDS = ["connect", "link", "list", "status", "resolve", "unlink", "disconnect"] as const;
type Command = (typeof COMMANDS)[number];

interface Options {
	command: Command;
	argument?: string;
	initialize: boolean;
	rebind: boolean;
	json: boolean;
	help: boolean;
	projectId?: string;
	workspaceId?: string;
}

export function cloudCommandHelp(): string {
	return `Usage:
  ${APP_NAME} cloud connect <directory> [--init] [--rebind] [--json]
  ${APP_NAME} cloud link <directory> [--init | --id <project-uuid>] [--workspace <workspace-uuid>] [--rebind] [--json]
  ${APP_NAME} cloud list [--json]
  ${APP_NAME} cloud status [--json]
  ${APP_NAME} cloud resolve <project-uuid> [--json]
  ${APP_NAME} cloud unlink <project-uuid> [--json]
  ${APP_NAME} cloud disconnect <workspace-uuid> [--json]

Connect existing local/desktop-synced folders; --init explicitly creates an identity.
Use --rebind to change a known identity's local location. Without --workspace,
link stores a direct local path; with it, the project is relative to that workspace.
--id links a known project without creating a marker. --init and --id are exclusive.
resolve prints only the existing local directory (or {projectId,path} with --json).
list reads registrations; status validates local availability, not cloud delivery.
Unlink/disconnect remove local bindings only, never folders, markers or sessions.
No OAuth, provider API, session sync, automatic agent launch or trust grant.
  ${APP_NAME} cloud [<command>] --help`;
}

function parse(args: string[]): Options {
	const command = args[0] as Command;
	if (!COMMANDS.includes(command)) throw new Error(`Unknown cloud command: ${args[0]}.`);
	const result: Options = { command, initialize: false, rebind: false, json: false, help: false };
	const seen = new Set<string>();
	const positional: string[] = [];
	for (let i = 1; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--") {
			positional.push(...args.slice(i + 1));
			break;
		}
		if (!arg.startsWith("-")) {
			positional.push(arg);
			continue;
		}
		const flag = arg === "-h" ? "--help" : arg;
		if (seen.has(flag)) throw new Error(`Repeated option ${flag}.`);
		seen.add(flag);
		if (flag === "--help") result.help = true;
		else if (flag === "--json") result.json = true;
		else if (flag === "--init" && (command === "connect" || command === "link")) result.initialize = true;
		else if (flag === "--rebind" && (command === "connect" || command === "link")) result.rebind = true;
		else if ((flag === "--id" || flag === "--workspace") && command === "link") {
			const value = args[++i];
			if (!value || value.startsWith("-")) throw new Error(`Missing value for ${flag}.`);
			if (flag === "--id") result.projectId = cloudId(value);
			else result.workspaceId = cloudId(value);
		} else throw new Error(`Unknown option ${arg} for cloud ${command}.`);
	}
	if (result.initialize && result.projectId) throw new Error("Choose --init or --id, not both.");
	const count = command === "list" || command === "status" ? 0 : 1;
	if (positional.length > count || (!result.help && positional.length !== count)) {
		throw new Error(`cloud ${command} requires ${count === 0 ? "no arguments" : "one directory or full UUID"}.`);
	}
	result.argument = positional[0];
	return result;
}

function directory(value: string): string {
	// A foreign Windows absolute path must not become a funny relative POSIX folder.
	if ((win32.isAbsolute(value) || /^[a-z]:/i.test(value)) && !isAbsolute(value)) {
		throw new Error("Use an existing absolute path on this device.");
	}
	const path = resolveDirectoryPath(value, process.cwd());
	if (!path) throw new Error("Directory must not be empty.");
	return path;
}

function locationText(location: CloudProjectLocation): string {
	return location.kind === "local"
		? location.path
		: `${location.workspaceId}/${location.relativePath} (workspace-relative)`;
}

export function formatCloudWorkspaceList(state: CloudWorkspaceState): string {
	return [
		"Workspaces (local registrations):",
		...(state.workspaces.length ? state.workspaces.map((item) => `  ${item.id}  ${item.path}`) : ["  (none)"]),
		"Projects:",
		...(state.projects.length
			? state.projects.map((item) => `  ${item.id}  ${locationText(item.location)}`)
			: ["  (none)"]),
	].join("\n");
}

export function formatCloudWorkspaceStatus(status: CloudWorkspaceStatus): string {
	const lines = ["Local availability only; cloud delivery is not verified."];
	for (const [name, items] of [
		["Workspaces", status.workspaces],
		["Projects", status.projects],
	] as const) {
		lines.push(`${name}:`);
		if (!items.length) lines.push("  (none)");
		for (const item of items) {
			lines.push(
				`  ${item.id}  ${item.available ? `available locally: ${item.path}` : `unavailable: ${item.error.message}`}`,
			);
		}
	}
	return lines.join("\n");
}

/** True for every cloud invocation, including errors: malformed commands never become prompts. */
export async function handleCloudCommand(args: string[]): Promise<boolean> {
	if (args[0] !== "cloud") return false;
	try {
		if (args.length === 1 || (args.length === 2 && (args[1] === "--help" || args[1] === "-h"))) {
			console.log(cloudCommandHelp());
			return true;
		}
		const options = parse(args.slice(1));
		if (options.help) {
			console.log(cloudCommandHelp());
			return true;
		}
		const registry = new CloudWorkspaceRegistry();
		const argument = options.argument ?? "";
		const print = (value: unknown, text: string) => console.log(options.json ? JSON.stringify(value) : text);
		switch (options.command) {
			case "connect": {
				const binding = await registry.connect(directory(argument), options);
				print(
					binding,
					`Connected workspace ${binding.id}\n  ${binding.path}\nLocal registration only; cloud delivery is not verified.`,
				);
				break;
			}
			case "link": {
				const binding = await registry.link(directory(argument), options);
				print(binding, `Linked project ${binding.id}\n  ${locationText(binding.location)}`);
				break;
			}
			case "list": {
				const state = await registry.list();
				print(state, formatCloudWorkspaceList(state));
				break;
			}
			case "status": {
				const status = await registry.status();
				print(status, formatCloudWorkspaceStatus(status));
				break;
			}
			case "resolve": {
				const projectId = cloudId(argument);
				const path = await registry.resolve(projectId);
				print({ projectId, path }, path);
				break;
			}
			case "unlink":
			case "disconnect": {
				const id = cloudId(argument);
				const project = options.command === "unlink";
				const removed = project ? await registry.unlink(id) : await registry.disconnect(id);
				print(
					{ id, removed },
					`${project ? "Project" : "Workspace"} ${id}: ${removed ? "local binding removed" : "not registered"}. Files are unchanged.`,
				);
				break;
			}
		}
	} catch (error) {
		const prefix = error instanceof CloudWorkspaceError ? `[${error.code}] ` : "";
		console.error(
			`Cloud workspaces: ${prefix}${error instanceof Error ? error.message : String(error)}\nUse '${APP_NAME} cloud --help'.`,
		);
		process.exitCode = 1;
	}
	return true;
}
