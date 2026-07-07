import { beforeEach, describe, expect, it } from "vitest";
import {
	DashboardAuth,
	isAllowedLocalHost,
	isLoopbackAddress,
	MemoryPairingStorage,
	normalizeAddress,
	type TailscaleIdentity,
	type TailscaleResolver,
} from "../src/server/auth.js";

class StubResolver implements TailscaleResolver {
	constructor(private readonly map: Record<string, TailscaleIdentity | null> = {}) {}
	async resolve(address: string): Promise<TailscaleIdentity | null> {
		if (address in this.map) return this.map[address];
		return null;
	}
}

class ThrowingResolver implements TailscaleResolver {
	async resolve(): Promise<TailscaleIdentity | null> {
		throw new Error("resolver exploded");
	}
}

class ThrowingStorage extends MemoryPairingStorage {
	override async load(): Promise<never> {
		throw new Error("storage exploded");
	}
}

const LOCAL_REQUEST = {
	remoteAddress: "127.0.0.1",
	hostHeader: "127.0.0.1:5343",
	originHeader: undefined,
	deviceToken: undefined,
};

describe("address helpers", () => {
	it("normalizes IPv6-mapped IPv4 and zone indices", () => {
		expect(normalizeAddress("::ffff:127.0.0.1")).toBe("127.0.0.1");
		expect(normalizeAddress("fe80::1%eth0")).toBe("fe80::1");
		expect(normalizeAddress("[::1]")).toBe("::1");
		expect(normalizeAddress(undefined)).toBe("");
	});

	it("identifies loopback addresses", () => {
		expect(isLoopbackAddress("127.0.0.1")).toBe(true);
		expect(isLoopbackAddress("127.1.2.3")).toBe(true);
		expect(isLoopbackAddress("::1")).toBe(true);
		expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
		expect(isLoopbackAddress("192.168.1.5")).toBe(false);
		expect(isLoopbackAddress("100.64.0.1")).toBe(false);
		expect(isLoopbackAddress(undefined)).toBe(false);
	});

	it("validates local Host headers (DNS-rebinding defense)", () => {
		expect(isAllowedLocalHost("localhost")).toBe(true);
		expect(isAllowedLocalHost("localhost:5343")).toBe(true);
		expect(isAllowedLocalHost("127.0.0.1:5343")).toBe(true);
		expect(isAllowedLocalHost("[::1]:5343")).toBe(true);
		expect(isAllowedLocalHost("evil.example.com")).toBe(false);
		expect(isAllowedLocalHost("evil.example.com:5343")).toBe(false);
		expect(isAllowedLocalHost("127.0.0.1.evil.com")).toBe(false);
		expect(isAllowedLocalHost(undefined)).toBe(false);
		expect(isAllowedLocalHost("")).toBe(false);
	});
});

describe("DashboardAuth — local mode", () => {
	let auth: DashboardAuth;
	beforeEach(() => {
		auth = new DashboardAuth();
	});

	it("allows loopback requests with a loopback Host", async () => {
		const decision = await auth.authenticate(LOCAL_REQUEST);
		expect(decision).toEqual({ allowed: true, mode: "local" });
	});

	it("rejects loopback requests with a foreign Host header", async () => {
		const decision = await auth.authenticate({ ...LOCAL_REQUEST, hostHeader: "attacker.example:5343" });
		expect(decision.allowed).toBe(false);
		if (!decision.allowed) {
			expect(decision.status).toBe(403);
			expect(decision.reason).toContain("DNS-rebinding");
		}
	});

	it("rejects loopback requests with a missing Host header", async () => {
		const decision = await auth.authenticate({ ...LOCAL_REQUEST, hostHeader: undefined });
		expect(decision.allowed).toBe(false);
	});

	it("rejects loopback requests with a cross-site Origin", async () => {
		const decision = await auth.authenticate({ ...LOCAL_REQUEST, originHeader: "https://evil.example" });
		expect(decision.allowed).toBe(false);
		if (!decision.allowed) expect(decision.reason).toContain("Origin");
	});

	it("allows loopback requests with a loopback Origin", async () => {
		const decision = await auth.authenticate({ ...LOCAL_REQUEST, originHeader: "http://127.0.0.1:5343" });
		expect(decision.allowed).toBe(true);
	});

	it("denies non-loopback requests when remote is disabled — no LAN mode", async () => {
		const decision = await auth.authenticate({
			remoteAddress: "192.168.1.50",
			hostHeader: "192.168.1.2:5343",
			originHeader: undefined,
			deviceToken: undefined,
		});
		expect(decision.allowed).toBe(false);
		if (!decision.allowed) {
			expect(decision.status).toBe(403);
			expect(decision.reason).toContain("disabled");
		}
	});
});

describe("DashboardAuth — remote mode", () => {
	const alice: TailscaleIdentity = { loginName: "alice@example.com", device: "phone" };
	const REMOTE = {
		remoteAddress: "100.64.0.9",
		hostHeader: "host.tailnet:5343",
		originHeader: undefined,
		deviceToken: undefined,
	};

	function makeAuth(overrides: Partial<ConstructorParameters<typeof DashboardAuth>[0]> = {}) {
		return new DashboardAuth({
			remoteEnabled: true,
			allowedIdentities: ["alice@example.com"],
			resolver: new StubResolver({ "100.64.0.9": alice, "100.64.0.66": { loginName: "mallory@example.com" } }),
			storage: new MemoryPairingStorage(),
			...overrides,
		});
	}

	it("denies unknown peers", async () => {
		const auth = makeAuth();
		const decision = await auth.authenticate({ ...REMOTE, remoteAddress: "100.64.0.250" });
		expect(decision.allowed).toBe(false);
		if (!decision.allowed) expect(decision.reason).toContain("not a known Tailscale peer");
	});

	it("denies identities not on the allowlist, naming them", async () => {
		const auth = makeAuth();
		const decision = await auth.authenticate({ ...REMOTE, remoteAddress: "100.64.0.66" });
		expect(decision.allowed).toBe(false);
		if (!decision.allowed) expect(decision.reason).toContain("mallory@example.com");
	});

	it("denies everyone when the allowlist is empty (fail-closed)", async () => {
		const auth = makeAuth({ allowedIdentities: [] });
		const decision = await auth.authenticate(REMOTE);
		expect(decision.allowed).toBe(false);
	});

	it("requires pairing for allowed identities without a device token", async () => {
		const auth = makeAuth();
		const decision = await auth.authenticate(REMOTE);
		expect(decision.allowed).toBe(false);
		if (!decision.allowed) {
			expect(decision.status).toBe(401);
			expect(decision.needsPairing).toBe(true);
			expect(decision.identity?.loginName).toBe("alice@example.com");
		}
	});

	it("pairs with a valid PIN and then authenticates with the device token", async () => {
		const auth = makeAuth();
		const { pin } = auth.generatePin();
		const { token, device } = await auth.pair(REMOTE, pin);
		expect(device.identity).toBe("alice@example.com");

		const decision = await auth.authenticate({ ...REMOTE, deviceToken: token });
		expect(decision.allowed).toBe(true);
		if (decision.allowed && decision.mode === "remote") {
			expect(decision.identity.loginName).toBe("alice@example.com");
		}
	});

	it("rejects an incorrect PIN", async () => {
		const auth = makeAuth();
		auth.generatePin();
		await expect(auth.pair(REMOTE, "000000")).rejects.toThrow(/Incorrect PIN/);
	});

	it("PINs are single-use", async () => {
		const auth = makeAuth();
		const { pin } = auth.generatePin();
		await auth.pair(REMOTE, pin);
		await expect(auth.pair(REMOTE, pin)).rejects.toThrow(/No active pairing PIN/);
	});

	it("PINs expire", async () => {
		let now = 1_000_000;
		const auth = makeAuth({ now: () => now, pinTtlMs: 5 * 60 * 1000 });
		const { pin } = auth.generatePin();
		now += 5 * 60 * 1000 + 1;
		await expect(auth.pair(REMOTE, pin)).rejects.toThrow(/No active pairing PIN/);
	});

	it("expired pairings stop authenticating", async () => {
		let now = 1_000_000;
		const auth = makeAuth({ now: () => now, pairingTtlMs: 1000 });
		const { pin } = auth.generatePin();
		const { token } = await auth.pair(REMOTE, pin);
		now += 1001;
		const decision = await auth.authenticate({ ...REMOTE, deviceToken: token });
		expect(decision.allowed).toBe(false);
	});

	it("rejects a garbage device token", async () => {
		const auth = makeAuth();
		const decision = await auth.authenticate({ ...REMOTE, deviceToken: "forged-token" });
		expect(decision.allowed).toBe(false);
	});

	it("unpaired devices lose access", async () => {
		const auth = makeAuth();
		const { pin } = auth.generatePin();
		const { token, device } = await auth.pair(REMOTE, pin);
		expect(await auth.unpair(device.id)).toBe(true);
		const decision = await auth.authenticate({ ...REMOTE, deviceToken: token });
		expect(decision.allowed).toBe(false);
	});

	it("loopback clients cannot pair", async () => {
		const auth = makeAuth();
		auth.generatePin();
		await expect(auth.pair(LOCAL_REQUEST, "123456")).rejects.toThrow(/do not pair/);
	});

	it("resolver failure denies (fail-closed)", async () => {
		const auth = makeAuth({ resolver: new ThrowingResolver() });
		const decision = await auth.authenticate(REMOTE);
		expect(decision.allowed).toBe(false);
		if (!decision.allowed) expect(decision.reason).toContain("resolver exploded");
	});

	it("storage failure denies (fail-closed)", async () => {
		const auth = makeAuth({ storage: new ThrowingStorage() });
		const { pin } = auth.generatePin();
		await expect(auth.pair(REMOTE, pin)).rejects.toThrow(/storage exploded/);
		const decision = await auth.authenticate({ ...REMOTE, deviceToken: "whatever" });
		expect(decision.allowed).toBe(false);
	});
});
