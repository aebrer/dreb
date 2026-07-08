/**
 * Dashboard auth — exactly two modes (SPEC.md §6):
 *
 * Mode A — local-only (default): the server binds loopback only. Requests are
 * additionally checked for loopback source address AND an allowlisted Host
 * header (DNS-rebinding defense: a malicious website can point its own domain
 * at 127.0.0.1 and drive the API from the victim's browser unless Host is
 * validated). No login, no pairing.
 *
 * Mode B — remote (explicit opt-in): requires Tailscale. Enforcement layers,
 * all fail-closed: (1) Tailscale identity resolution of the peer address,
 * (2) identity allowlist (empty allowlist = deny all), (3) first-login
 * rotating pairing code (visible only from the host/local dashboard),
 * (4) signed per-device cookie thereafter.
 *
 * There is no LAN mode. Any auth-subsystem error denies the request.
 */

import { execFile } from "node:child_process";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PAIRING_CODE_STEP_MS = 30_000;

// ---------------------------------------------------------------------------
// Address / Host helpers
// ---------------------------------------------------------------------------

/** Normalize an address for comparison (strip IPv6-mapped IPv4 prefix and zone). */
export function normalizeAddress(address: string | undefined): string {
	if (!address) return "";
	let a = address.trim();
	if (a.startsWith("[") && a.endsWith("]")) a = a.slice(1, -1);
	const zone = a.indexOf("%");
	if (zone !== -1) a = a.slice(0, zone);
	if (a.startsWith("::ffff:")) a = a.slice(7);
	return a;
}

/** True when the (normalized) address is a loopback address. */
export function isLoopbackAddress(address: string | undefined): boolean {
	const a = normalizeAddress(address);
	if (!a) return false;
	if (a === "::1") return true;
	return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a);
}

/**
 * Validate a Host header against the loopback allowlist. Rejecting foreign
 * hosts breaks DNS rebinding: the attacker's page can reach 127.0.0.1, but its
 * requests carry the attacker's hostname in Host.
 */
export function isAllowedLocalHost(hostHeader: string | undefined): boolean {
	if (!hostHeader) return false;
	// Strip port. IPv6 hosts arrive as "[::1]:port".
	let host = hostHeader.trim().toLowerCase();
	const v6 = host.match(/^\[([^\]]+)\](?::\d+)?$/);
	if (v6) {
		host = v6[1];
	} else {
		const colon = host.lastIndexOf(":");
		if (colon !== -1 && /^\d+$/.test(host.slice(colon + 1))) host = host.slice(0, colon);
	}
	return host === "localhost" || host === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

// ---------------------------------------------------------------------------
// Tailscale identity
// ---------------------------------------------------------------------------

export interface TailscaleIdentity {
	/** Login name (e.g. "alice@example.com") — the allowlist unit. */
	loginName: string;
	/** Device host name, when known. */
	device?: string;
}

export interface TailscaleResolver {
	/** Resolve a peer IP to a Tailscale identity, or null when unknown. */
	resolve(address: string): Promise<TailscaleIdentity | null>;
}

interface TailscaleStatusPeer {
	TailscaleIPs?: string[];
	HostName?: string;
	UserID?: number;
}

interface TailscaleStatusJson {
	Self?: TailscaleStatusPeer & { UserID?: number };
	Peer?: Record<string, TailscaleStatusPeer>;
	User?: Record<string, { LoginName?: string }>;
}

/** Resolves identities via `tailscale status --json`. Any failure resolves null (deny). */
export class TailscaleStatusResolver implements TailscaleResolver {
	async resolve(address: string): Promise<TailscaleIdentity | null> {
		const target = normalizeAddress(address);
		if (!target) return null;
		let status: TailscaleStatusJson;
		try {
			const { stdout } = await execFileAsync("tailscale", ["status", "--json"], {
				timeout: 3000,
				maxBuffer: 4 * 1024 * 1024,
			});
			status = JSON.parse(stdout) as TailscaleStatusJson;
		} catch {
			// Tailscale absent, not running, or unparseable — fail closed.
			return null;
		}
		const peers = Object.values(status.Peer ?? {});
		if (status.Self) peers.push(status.Self);
		for (const peer of peers) {
			if (!peer.TailscaleIPs?.some((ip) => normalizeAddress(ip) === target)) continue;
			const userId = peer.UserID;
			const loginName = userId !== undefined ? status.User?.[String(userId)]?.LoginName : undefined;
			if (!loginName) return null; // identity unknown — deny rather than guess
			return { loginName, device: peer.HostName };
		}
		return null;
	}
}

// ---------------------------------------------------------------------------
// Pairing store (rotating pairing codes + device tokens)
// ---------------------------------------------------------------------------

export interface PairedDevice {
	id: string;
	identity: string;
	device?: string;
	createdAt: string;
	expiresAt: string;
}

interface StoredPairing extends PairedDevice {
	/** HMAC of the device token (raw token never stored). */
	tokenHmac: string;
}

export interface PairingStorage {
	load(): Promise<StoredPairing[]>;
	save(pairings: StoredPairing[]): Promise<void>;
}

/** In-memory storage — used in tests and as the base for the file store. */
export class MemoryPairingStorage implements PairingStorage {
	private pairings: StoredPairing[] = [];
	async load(): Promise<StoredPairing[]> {
		return [...this.pairings];
	}
	async save(pairings: StoredPairing[]): Promise<void> {
		this.pairings = [...pairings];
	}
}

export interface DashboardAuthOptions {
	/** Remote (Tailscale) mode. Default false — loopback only. */
	remoteEnabled?: boolean;
	/** Allowed Tailscale login names. Empty = deny all remote. */
	allowedIdentities?: string[];
	/** Device pairing validity. Default 30 days. */
	pairingTtlMs?: number;
	resolver?: TailscaleResolver;
	storage?: PairingStorage;
	/** HMAC secret for device tokens. Generated per-instance when omitted. */
	secret?: Buffer;
	/** Clock override for tests. */
	now?: () => number;
}

export type AuthDecision =
	| { allowed: true; mode: "local" }
	| { allowed: true; mode: "remote"; identity: TailscaleIdentity }
	| {
			allowed: false;
			status: number;
			reason: string;
			/** Set when an allowed identity needs pairing-code entry. */
			needsPairing?: boolean;
			identity?: TailscaleIdentity;
	  };

export interface AuthRequestInfo {
	remoteAddress: string | undefined;
	hostHeader: string | undefined;
	/** Origin header when present. Non-loopback origins are rejected on local requests. */
	originHeader: string | undefined;
	/** Value of the dashboard device cookie, when present. */
	deviceToken: string | undefined;
}

function timingSafeEqualStr(a: string, b: string): boolean {
	const ab = Buffer.from(a);
	const bb = Buffer.from(b);
	if (ab.length !== bb.length) return false;
	return timingSafeEqual(ab, bb);
}

export class DashboardAuth {
	private readonly remoteEnabled: boolean;
	private readonly allowedIdentities: Set<string>;
	private readonly pairingTtlMs: number;
	private readonly resolver: TailscaleResolver;
	private readonly storage: PairingStorage;
	private readonly secret: Buffer;
	private readonly now: () => number;

	constructor(options: DashboardAuthOptions = {}) {
		this.remoteEnabled = options.remoteEnabled ?? false;
		this.allowedIdentities = new Set(options.allowedIdentities ?? []);
		this.pairingTtlMs = options.pairingTtlMs ?? 30 * 24 * 60 * 60 * 1000;
		this.resolver = options.resolver ?? new TailscaleStatusResolver();
		this.storage = options.storage ?? new MemoryPairingStorage();
		this.secret = options.secret ?? randomBytes(32);
		this.now = options.now ?? Date.now;
	}

	get isRemoteEnabled(): boolean {
		return this.remoteEnabled;
	}

	private hmac(value: string): string {
		return createHmac("sha256", this.secret).update(value).digest("hex");
	}

	private pairingCodeForWindow(window: number): string {
		const counter = Buffer.alloc(8);
		counter.writeBigUInt64BE(BigInt(window));
		const digest = createHmac("sha1", this.secret).update(counter).digest();
		const offset = digest[digest.length - 1]! & 0x0f;
		const value =
			((digest[offset]! & 0x7f) << 24) |
			((digest[offset + 1]! & 0xff) << 16) |
			((digest[offset + 2]! & 0xff) << 8) |
			(digest[offset + 3]! & 0xff);
		return String(value % 1_000_000).padStart(6, "0");
	}

	/** Current RFC-6238-style rotating code for pairing new remote devices. */
	currentPairingCode(): { code: string; expiresInMs: number } {
		const nowMs = this.now();
		const window = Math.floor(nowMs / PAIRING_CODE_STEP_MS);
		const expiresInMs = (window + 1) * PAIRING_CODE_STEP_MS - nowMs;
		return { code: this.pairingCodeForWindow(window), expiresInMs };
	}

	private isValidPairingCode(code: string): boolean {
		if (!/^\d{6}$/.test(code)) return false;
		const window = Math.floor(this.now() / PAIRING_CODE_STEP_MS);
		for (const candidateWindow of [window - 1, window, window + 1]) {
			if (candidateWindow < 0) continue;
			if (timingSafeEqualStr(code, this.pairingCodeForWindow(candidateWindow))) return true;
		}
		return false;
	}

	/**
	 * Authenticate a request. Fail-closed: any resolver/storage error results in
	 * a deny, never a pass-through.
	 */
	async authenticate(info: AuthRequestInfo): Promise<AuthDecision> {
		try {
			return await this.authenticateInner(info);
		} catch (err) {
			return {
				allowed: false,
				status: 500,
				reason: `Auth subsystem error — denying: ${err instanceof Error ? err.message : String(err)}`,
			};
		}
	}

	private async authenticateInner(info: AuthRequestInfo): Promise<AuthDecision> {
		if (isLoopbackAddress(info.remoteAddress)) {
			if (!isAllowedLocalHost(info.hostHeader)) {
				return {
					allowed: false,
					status: 403,
					reason: `Host header "${info.hostHeader ?? "(missing)"}" is not a loopback host — rejected (DNS-rebinding defense)`,
				};
			}
			if (info.originHeader) {
				let originHost: string | undefined;
				try {
					originHost = new URL(info.originHeader).host;
				} catch {
					originHost = undefined;
				}
				if (!originHost || !isAllowedLocalHost(originHost)) {
					return {
						allowed: false,
						status: 403,
						reason: `Origin "${info.originHeader}" is not a loopback origin — rejected (cross-site defense)`,
					};
				}
			}
			return { allowed: true, mode: "local" };
		}

		if (!this.remoteEnabled) {
			return { allowed: false, status: 403, reason: "Remote dashboard access is disabled" };
		}

		const identity = await this.resolver.resolve(info.remoteAddress ?? "");
		if (!identity) {
			return { allowed: false, status: 403, reason: "Client is not a known Tailscale peer" };
		}
		if (this.allowedIdentities.size === 0 || !this.allowedIdentities.has(identity.loginName)) {
			return {
				allowed: false,
				status: 403,
				reason: `Tailscale identity "${identity.loginName}" is not on the dashboard allowlist`,
				identity,
			};
		}

		if (!info.deviceToken || !(await this.isPaired(identity, info.deviceToken))) {
			return {
				allowed: false,
				status: 401,
				reason: "Device is not paired — pairing code required",
				needsPairing: true,
				identity,
			};
		}

		return { allowed: true, mode: "remote", identity };
	}

	/**
	 * Complete pairing for an allowed remote identity using the current rotating
	 * code. Returns the device token to set as a cookie. Throws (with `status`) on
	 * any failure.
	 */
	async pair(info: AuthRequestInfo, code: string): Promise<{ token: string; device: PairedDevice }> {
		if (isLoopbackAddress(info.remoteAddress)) {
			throw Object.assign(new Error("Loopback clients do not pair"), { status: 400 });
		}
		if (!this.remoteEnabled) {
			throw Object.assign(new Error("Remote dashboard access is disabled"), { status: 403 });
		}
		const identity = await this.resolver.resolve(info.remoteAddress ?? "");
		if (!identity || this.allowedIdentities.size === 0 || !this.allowedIdentities.has(identity.loginName)) {
			throw Object.assign(new Error("Identity is not on the dashboard allowlist"), { status: 403 });
		}
		if (!this.isValidPairingCode(code)) {
			throw Object.assign(new Error("Incorrect pairing code"), { status: 401 });
		}

		const token = randomBytes(32).toString("base64url");
		const nowMs = this.now();
		const device: PairedDevice = {
			id: randomBytes(8).toString("hex"),
			identity: identity.loginName,
			device: identity.device,
			createdAt: new Date(nowMs).toISOString(),
			expiresAt: new Date(nowMs + this.pairingTtlMs).toISOString(),
		};
		const pairings = await this.loadLive();
		pairings.push({ ...device, tokenHmac: this.hmac(token) });
		await this.storage.save(pairings);
		return { token, device };
	}

	/** List paired devices (live only). */
	async listDevices(): Promise<PairedDevice[]> {
		return (await this.loadLive()).map(({ tokenHmac: _tokenHmac, ...device }) => device);
	}

	/** Remove a paired device by id. Returns true when something was removed. */
	async unpair(deviceId: string): Promise<boolean> {
		const pairings = await this.loadLive();
		const remaining = pairings.filter((p) => p.id !== deviceId);
		if (remaining.length === pairings.length) return false;
		await this.storage.save(remaining);
		return true;
	}

	private async isPaired(identity: TailscaleIdentity, token: string): Promise<boolean> {
		const tokenHmac = this.hmac(token);
		const live = await this.loadLive();
		return live.some((p) => p.identity === identity.loginName && timingSafeEqualStr(p.tokenHmac, tokenHmac));
	}

	/** Load pairings, dropping (and persisting the removal of) expired entries. */
	private async loadLive(): Promise<StoredPairing[]> {
		const all = await this.storage.load();
		const nowMs = this.now();
		const live = all.filter((p) => new Date(p.expiresAt).getTime() > nowMs);
		if (live.length !== all.length) await this.storage.save(live);
		return live;
	}
}
