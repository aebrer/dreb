/**
 * RPC client and types for programmatic access to the coding agent.
 *
 * Usage:
 *   import { RpcClient } from "@dreb/coding-agent/rpc";
 */

export type { ModelInfo, RpcClientOptions, RpcEventListener, RpcExitInfo, RpcExitListener } from "./rpc-client.js";
export { RpcClient } from "./rpc-client.js";
export {
	createDashboardRpcEventProjector,
	projectDashboardRpcEvent,
} from "./rpc-event-projection.js";
export type {
	RpcAgentTypeInfo,
	RpcBackgroundAgentInfo,
	RpcCommand,
	RpcCommandType,
	RpcContextTrustEvaluation,
	RpcContextTrustMutationResult,
	RpcDashboardSnapshot,
	RpcDashboardSnapshotBarrierEvent,
	RpcEvent,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcPendingMessages,
	RpcPerformanceStats,
	RpcQueuedMessage,
	RpcResources,
	RpcResponse,
	RpcScopedModel,
	RpcSessionInfo,
	RpcSessionState,
	RpcSessionTask,
	RpcSettingsSetResult,
	RpcSettingsSnapshot,
	RpcSettingsUpdate,
	RpcSlashCommand,
	RpcTreeNode,
	RpcTrustedFolderRemovalResult,
} from "./rpc-types.js";
