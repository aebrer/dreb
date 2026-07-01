import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DashboardAuth, type TailscaleIdentityResolver } from "../src/auth.js";

const identity = {
	id: "user@example.com",
	loginName: "user@example.com",
	deviceName: "phone",
	dnsName: "phone.tailnet.ts.net.",
	addresses: ["100.64.0.2"],
};

function req(remoteAddress: string, headers: Record<string, string> = {}) {
	return { socket: { remoteAddress }, headers } as any;
}

describe("DashboardAuth", () => {
	it("allows loopback clients without pairing", async () => {
		const auth = new DashboardAuth();
		await expect(auth.authenticate(req("127.0.0.1"))).resolves.toMatchObject({ allowed: true, loopback: true });
		await expect(auth.authenticate(req("::ffff:127.0.0.1"))).resolves.toMatchObject({
			allowed: true,
			loopback: true,
		});
	});

	it("fails closed for remote clients when remote access is disabled", async () => {
		const resolver: TailscaleIdentityResolver = { resolve: async () => identity };
		const auth = new DashboardAuth({ resolver });
		await expect(auth.authenticate(req("100.64.0.2"))).resolves.toMatchObject({ allowed: false, status: 403 });
	});

	it("requires an allowed Tailscale identity and short-lived PIN pairing for remote clients", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "dreb-dashboard-auth-"));
		const resolver: TailscaleIdentityResolver = { resolve: async () => identity };
		const auth = new DashboardAuth({
			remoteEnabled: true,
			agentDir,
			resolver,
			allowedIdentities: ["user@example.com"],
			allowedDevices: ["phone"],
		});

		await expect(auth.authenticate(req("100.64.0.2"))).resolves.toMatchObject({ allowed: false, status: 401 });
		const pin = auth.generatePin();
		await expect(auth.pair(req("100.64.0.2"), "000000")).rejects.toThrow("Invalid or expired pairing PIN");
		const pairing = await auth.pair(req("100.64.0.2"), pin.pin);
		await expect(
			auth.authenticate(req("100.64.0.2", { authorization: `Bearer ${pairing.token}` })),
		).resolves.toMatchObject({ allowed: true, loopback: false });

		const stored = JSON.parse(await readFile(join(agentDir, "dashboard-pairings.json"), "utf8"));
		expect(stored.pairings).toHaveLength(1);
		expect(stored.pairings[0].identityId).toBe("user@example.com");
		expect(stored.pairings[0].tokenHash).not.toBe(pairing.token);
	});

	it("denies remote clients when no Tailscale identity or device allowlist is configured", async () => {
		const resolver: TailscaleIdentityResolver = { resolve: async () => identity };
		const auth = new DashboardAuth({ remoteEnabled: true, resolver });
		await expect(auth.authenticate(req("100.64.0.2"))).resolves.toMatchObject({ allowed: false, status: 403 });
	});

	it("denies remote clients when the Tailscale resolver has no matching identity", async () => {
		const auth = new DashboardAuth({
			remoteEnabled: true,
			resolver: { resolve: async () => null },
			allowedIdentities: ["user@example.com"],
		});
		await expect(auth.authenticate(req("203.0.113.1"))).resolves.toMatchObject({ allowed: false, status: 403 });
	});
});
