/**
 * RPC client and types for programmatic access to the coding agent.
 *
 * Usage:
 *   import { RpcClient } from "@dreb/coding-agent/rpc";
 */

export type { ModelInfo, RpcClientOptions, RpcEventListener, RpcExitInfo, RpcExitListener } from "./rpc-client.js";
export { RpcClient } from "./rpc-client.js";
export type {
	RpcAgentTypeInfo,
	RpcBackgroundAgentInfo,
	RpcCommand,
	RpcCommandType,
	RpcContextTrustEvaluation,
	RpcContextTrustMutationResult,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
	RpcSessionInfo,
	RpcSessionState,
	RpcSettingsSetResult,
	RpcSettingsSnapshot,
	RpcSettingsUpdate,
	RpcSlashCommand,
	RpcTreeNode,
} from "./rpc-types.js";
