/**
 * RPC client and types for programmatic access to the coding agent.
 *
 * Usage:
 *   import { RpcClient } from "@dreb/coding-agent/rpc";
 */

export type { ModelInfo, RpcClientOptions, RpcEventListener } from "./rpc-client.js";
export { RpcClient } from "./rpc-client.js";
export type {
	RpcCommand,
	RpcCommandType,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
	RpcSessionInfo,
	RpcSessionState,
	RpcSlashCommand,
} from "./rpc-types.js";
