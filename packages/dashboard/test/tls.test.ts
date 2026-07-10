/**
 * Native TLS (HTTPS) CLI flag tests — `parseArgs` validation for `--https`,
 * `--cert`, `--key`. See `src/index.ts`. The dashboard terminates TLS itself
 * (no reverse proxy); this only checks the argument surface, not the live
 * handshake (which needs real cert files + a bound socket).
 */

import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/index.js";

describe("dashboard native TLS — parseArgs", () => {
	it("defaults to plain HTTP (https off, no cert/key)", () => {
		const a = parseArgs([]);
		expect(a.https).toBe(false);
		expect(a.cert).toBeUndefined();
		expect(a.key).toBeUndefined();
	});

	it("accepts --https with --cert and --key", () => {
		const a = parseArgs(["--https", "--cert", "/etc/dreb/cert.pem", "--key", "/etc/dreb/key.pem"]);
		expect(a.https).toBe(true);
		expect(a.cert).toBe("/etc/dreb/cert.pem");
		expect(a.key).toBe("/etc/dreb/key.pem");
	});

	it("rejects --https without --cert (no silent HTTP fallback)", () => {
		expect(() => parseArgs(["--https", "--key", "/k.pem"])).toThrow(/--https requires --cert/);
	});

	it("rejects --https without --key", () => {
		expect(() => parseArgs(["--https", "--cert", "/c.pem"])).toThrow(/--https requires --key/);
	});

	it("rejects --cert with no value", () => {
		expect(() => parseArgs(["--https", "--cert"])).toThrow(/--cert requires/);
	});

	it("rejects --key with no value", () => {
		expect(() => parseArgs(["--https", "--cert", "/c.pem", "--key"])).toThrow(/--key requires/);
	});

	it("combines --https with --remote + --allow (remote Tailscale over TLS)", () => {
		const a = parseArgs(["--remote", "--allow", "me@example.com", "--https", "--cert", "/c.pem", "--key", "/k.pem"]);
		expect(a.https).toBe(true);
		expect(a.remote).toBe(true);
		expect(a.allow).toEqual(["me@example.com"]);
	});

	it("still rejects --remote without --allow when --https is present", () => {
		expect(() => parseArgs(["--remote", "--https", "--cert", "/c.pem", "--key", "/k.pem"])).toThrow(
			/--remote requires/,
		);
	});

	it("rejects unknown arguments", () => {
		expect(() => parseArgs(["--bogus"])).toThrow(/Unknown argument/);
	});
});
