/** Metadata-only package entry point. Importing this module never starts an agent. */
export { getCloudWorkspaceRegistryPath } from "../../config.js";
export { CloudWorkspaceRegistry } from "./registry.js";
export {
	CLOUD_WORKSPACE_VERSION,
	type CloudIdentityMarker,
	type CloudLocationStatus,
	type CloudProjectBinding,
	type CloudProjectLocation,
	type CloudWorkspaceBinding,
	CloudWorkspaceError,
	type CloudWorkspaceErrorCode,
	type CloudWorkspaceState,
	type CloudWorkspaceStatus,
	type ConnectCloudWorkspaceOptions,
	type LinkCloudProjectOptions,
} from "./types.js";
