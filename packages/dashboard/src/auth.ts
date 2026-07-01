import { execFile } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface TailscaleIdentity {
	id: string;
	loginName?: string;
	user?: string;
	deviceName?: string;
	dnsName?: string;
	addresses: string[];
}

export interface TailscaleIdentityResolver {
	resolve(remoteAddress: string): Promise<TailscaleIdentity | null>;
}

export interface DashboardAuthOptions {
	remoteEnabled?: boolean;
	agentDir?: string;
	pinTtlMs?: number;
	pairingTtlMs?: number;
	allowedIdentities?: string[];
	allowedDevices?: string[];
	resolver?: TailscaleIdentityResolver;
}

interface StoredPairing {
	tokenHash: string;
	identityId: string;
	deviceId?: string;
	createdAt: string;
	expiresAt: string;
}

interface PairingFile {
	version: 1;
	pairings: StoredPairing[];
}

export interface AuthResult {
	allowed: boolean;
	status: number;
	reason?: string;
	loopback: boolean;
	identity?: TailscaleIdentity;
}

interface PinChallenge {
	hash: string;
	expiresAt: number;
}

export class DashboardAuth {
	private readonly remoteEnabled: boolean;
	private readonly agentDir: string;
	private readonly pinTtlMs: number;
	private readonly pairingTtlMs: number;
	private readonly allowedIdentities: Set<string>;
	private readonly allowedDevices: Set<string>;
	private readonly resolver: TailscaleIdentityResolver;
	private currentPin: PinChallenge | null = null;

	constructor(options: DashboardAuthOptions = {}) {
		this.remoteEnabled = options.remoteEnabled ?? false;
		this.agentDir = options.agentDir ?? join(homedir(), ".dreb", "agent");
		this.pinTtlMs = options.pinTtlMs ?? 5 * 60 * 1000;
		this.pairingTtlMs = options.pairingTtlMs ?? 30 * 24 * 60 * 60 * 1000;
		this.allowedIdentities = new Set(options.allowedIdentities ?? []);
		this.allowedDevices = new Set(options.allowedDevices ?? []);
		this.resolver = options.resolver ?? new TailscaleStatusResolver();
	}

	get pairingsPath(): string {
		return join(this.agentDir, "dashboard-pairings.json");
	}

	generatePin(): { pin: string; expiresAt: string } {
		const pin = String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0");
		const expiresAt = Date.now() + this.pinTtlMs;
		this.currentPin = { hash: hashSecret(pin), expiresAt };
		return { pin, expiresAt: new Date(expiresAt).toISOString() };
	}

	async authenticate(req: IncomingMessage): Promise<AuthResult> {
		const remoteAddress = getRemoteAddress(req);
		if (isLoopbackAddress(remoteAddress)) {
			return { allowed: true, status: 200, loopback: true };
		}

		if (!this.remoteEnabled) {
			return { allowed: false, status: 403, reason: "Remote dashboard access is disabled", loopback: false };
		}

		const identity = await this.resolver.resolve(remoteAddress);
		if (!identity || !this.isAllowedIdentity(identity)) {
			return {
				allowed: false,
				status: 403,
				reason: "Remote client is not an allowed Tailscale identity",
				loopback: false,
			};
		}

		const token = getBearerToken(req) ?? getCookie(req, "dreb_dashboard_pairing");
		if (!token || !(await this.isPaired(identity, token))) {
			return { allowed: false, status: 401, reason: "Remote client is not paired", loopback: false, identity };
		}

		return { allowed: true, status: 200, loopback: false, identity };
	}

	async pair(
		req: IncomingMessage,
		pin: string,
	): Promise<{ token: string; identity: TailscaleIdentity; expiresAt: string }> {
		const remoteAddress = getRemoteAddress(req);
		if (isLoopbackAddress(remoteAddress)) {
			throw Object.assign(new Error("Loopback clients do not require pairing"), { status: 400 });
		}
		if (!this.remoteEnabled) {
			throw Object.assign(new Error("Remote dashboard access is disabled"), { status: 403 });
		}
		const identity = await this.resolver.resolve(remoteAddress);
		if (!identity || !this.isAllowedIdentity(identity)) {
			throw Object.assign(new Error("Remote client is not an allowed Tailscale identity"), { status: 403 });
		}
		if (!this.verifyPin(pin)) {
			throw Object.assign(new Error("Invalid or expired pairing PIN"), { status: 401 });
		}

		const token = randomBytes(32).toString("base64url");
		const now = Date.now();
		const expiresAt = new Date(now + this.pairingTtlMs).toISOString();
		const file = await this.readPairings();
		file.pairings = file.pairings.filter((pairing) => new Date(pairing.expiresAt).getTime() > now);
		file.pairings.push({
			tokenHash: hashSecret(token),
			identityId: identity.id,
			deviceId: identity.deviceName ?? identity.dnsName,
			createdAt: new Date(now).toISOString(),
			expiresAt,
		});
		await this.writePairings(file);
		this.currentPin = null;
		return { token, identity, expiresAt };
	}

	private verifyPin(pin: string): boolean {
		if (!this.currentPin || Date.now() > this.currentPin.expiresAt) return false;
		return safeEqual(hashSecret(pin), this.currentPin.hash);
	}

	private isAllowedIdentity(identity: TailscaleIdentity): boolean {
		if (this.allowedIdentities.size === 0 && this.allowedDevices.size === 0) return false;

		const identityCandidates = [identity.id, identity.loginName, identity.user].filter(Boolean) as string[];
		const deviceCandidates = [identity.deviceName, identity.dnsName].filter(Boolean) as string[];
		const identityAllowed =
			this.allowedIdentities.size === 0 || identityCandidates.some((value) => this.allowedIdentities.has(value));
		const deviceAllowed =
			this.allowedDevices.size === 0 || deviceCandidates.some((value) => this.allowedDevices.has(value));
		return identityAllowed && deviceAllowed;
	}

	private async isPaired(identity: TailscaleIdentity, token: string): Promise<boolean> {
		const tokenHash = hashSecret(token);
		const now = Date.now();
		const file = await this.readPairings();
		let changed = false;
		const live = file.pairings.filter((pairing) => {
			const keep = new Date(pairing.expiresAt).getTime() > now;
			if (!keep) changed = true;
			return keep;
		});
		if (changed) {
			await this.writePairings({ version: 1, pairings: live });
		}
		return live.some((pairing) => pairing.identityId === identity.id && safeEqual(pairing.tokenHash, tokenHash));
	}

	private async readPairings(): Promise<PairingFile> {
		try {
			const parsed = JSON.parse(await readFile(this.pairingsPath, "utf8")) as PairingFile;
			if (parsed.version === 1 && Array.isArray(parsed.pairings)) return parsed;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		return { version: 1, pairings: [] };
	}

	private async writePairings(file: PairingFile): Promise<void> {
		await mkdir(this.agentDir, { recursive: true });
		await writeFile(this.pairingsPath, `${JSON.stringify(file, null, "\t")}\n`, { mode: 0o600 });
	}
}

export class TailscaleStatusResolver implements TailscaleIdentityResolver {
	async resolve(remoteAddress: string): Promise<TailscaleIdentity | null> {
		const address = normalizeAddress(remoteAddress);
		if (!address) return null;
		try {
			const { stdout } = await execFileAsync("tailscale", ["status", "--json"], {
				timeout: 3000,
				maxBuffer: 1024 * 1024,
			});
			const status = JSON.parse(stdout) as TailscaleStatus;
			const identities: TailscaleIdentity[] = [];
			if (status.Self) identities.push(identityFromNode(status.Self, "self"));
			for (const [id, peer] of Object.entries(status.Peer ?? {})) {
				identities.push(identityFromNode(peer, id));
			}
			return identities.find((identity) => identity.addresses.map(normalizeAddress).includes(address)) ?? null;
		} catch {
			return null;
		}
	}
}

interface TailscaleNode {
	ID?: string;
	PublicKey?: string;
	HostName?: string;
	DNSName?: string;
	TailscaleIPs?: string[];
	User?: string;
	LoginName?: string;
}

interface TailscaleStatus {
	Self?: TailscaleNode;
	Peer?: Record<string, TailscaleNode>;
}

function identityFromNode(node: TailscaleNode, fallbackId: string): TailscaleIdentity {
	return {
		id: node.ID ?? node.PublicKey ?? fallbackId,
		loginName: node.LoginName,
		user: node.User,
		deviceName: node.HostName,
		dnsName: node.DNSName,
		addresses: node.TailscaleIPs ?? [],
	};
}

function getRemoteAddress(req: IncomingMessage): string {
	return req.socket.remoteAddress ?? "";
}

export function isLoopbackAddress(address: string): boolean {
	const normalized = normalizeAddress(address);
	return normalized === "127.0.0.1" || normalized === "::1" || normalized === "0:0:0:0:0:0:0:1";
}

function normalizeAddress(address: string): string {
	let value = address.trim().toLowerCase();
	if (value.startsWith("::ffff:")) value = value.slice("::ffff:".length);
	return value;
}

function getBearerToken(req: IncomingMessage): string | null {
	const header = req.headers.authorization;
	if (!header) return null;
	const match = /^bearer\s+(.+)$/i.exec(header);
	return match?.[1] ?? null;
}

function getCookie(req: IncomingMessage, name: string): string | null {
	const cookie = req.headers.cookie;
	if (!cookie) return null;
	for (const part of cookie.split(";")) {
		const [key, ...rest] = part.trim().split("=");
		if (key === name) return decodeURIComponent(rest.join("="));
	}
	return null;
}

function hashSecret(secret: string): string {
	return createHash("sha256").update(secret).digest("base64url");
}

function safeEqual(left: string, right: string): boolean {
	const leftBuffer = Buffer.from(left);
	const rightBuffer = Buffer.from(right);
	return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
