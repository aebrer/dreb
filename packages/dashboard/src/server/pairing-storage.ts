/**
 * File-backed pairing storage — persists paired devices under the dreb agent
 * dir so pairings survive dashboard restarts. Written with mode 0600.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { MAX_PAIRING_TTL_DAYS, MIN_PAIRING_TTL_DAYS, type PairingState, type StoredPairing } from "./auth.js";

interface PairingFileV1 {
	version: 1;
	pairings: StoredPairing[];
	consumedPairingWindows?: number[];
}

interface PairingFileV2 {
	version: 2;
	pairings: StoredPairing[];
	consumedPairingWindows: number[];
	pairingTtlDays?: number;
}

type PairingFile = PairingFileV1 | PairingFileV2;

function isUtcDate(value: unknown): value is string {
	if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
	const parsed = Date.parse(`${value}T00:00:00.000Z`);
	return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

/**
 * Load or create the per-install dashboard auth secret. This secret keys both
 * device-token HMACs and the rotating pairing code, so it must survive process
 * restarts but must never be shared across installs/servers.
 */
export function loadOrCreateDashboardSecret(path: string): Buffer {
	try {
		const raw = readFileSync(path, "utf8").trim();
		if (!/^[0-9a-f]{64}$/i.test(raw)) throw new Error(`Invalid dashboard auth secret at ${path}`);
		return Buffer.from(raw, "hex");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	}

	mkdirSync(dirname(path), { recursive: true });
	const secret = randomBytes(32);
	try {
		writeFileSync(path, `${secret.toString("hex")}\n`, { mode: 0o600, flag: "wx" });
		return secret;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
		const raw = readFileSync(path, "utf8").trim();
		if (!/^[0-9a-f]{64}$/i.test(raw)) throw new Error(`Invalid dashboard auth secret at ${path}`);
		return Buffer.from(raw, "hex");
	}
}

export class FilePairingStorage {
	constructor(private readonly path: string) {}

	async load(): Promise<PairingState> {
		let raw: string;
		try {
			raw = readFileSync(this.path, "utf8");
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") {
				return { pairings: [], consumedPairingWindows: [] };
			}
			throw err;
		}
		const parsed = JSON.parse(raw) as PairingFile;
		if (
			(parsed.version !== 1 && parsed.version !== 2) ||
			!Array.isArray(parsed.pairings) ||
			(parsed.version === 2 && !Array.isArray(parsed.consumedPairingWindows)) ||
			(parsed.consumedPairingWindows !== undefined &&
				(!Array.isArray(parsed.consumedPairingWindows) ||
					!parsed.consumedPairingWindows.every((window) => Number.isSafeInteger(window)))) ||
			(parsed.version === 2 &&
				parsed.pairingTtlDays !== undefined &&
				(!Number.isSafeInteger(parsed.pairingTtlDays) ||
					parsed.pairingTtlDays < MIN_PAIRING_TTL_DAYS ||
					parsed.pairingTtlDays > MAX_PAIRING_TTL_DAYS)) ||
			!parsed.pairings.every(
				(pairing) =>
					pairing &&
					typeof pairing === "object" &&
					(pairing.lastExpiryWarningUtcDate === undefined || isUtcDate(pairing.lastExpiryWarningUtcDate)),
			)
		) {
			throw new Error(`Unrecognized pairing file format at ${this.path}`);
		}
		return {
			pairings: parsed.pairings,
			consumedPairingWindows: parsed.consumedPairingWindows ?? [],
			pairingTtlDays: parsed.version === 2 ? parsed.pairingTtlDays : undefined,
		};
	}

	async save(state: PairingState): Promise<void> {
		const dir = dirname(this.path);
		mkdirSync(dir, { recursive: true });
		const file: PairingFileV2 = { version: 2, ...state };
		const tmp = join(dir, `.${basename(this.path)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
		try {
			writeFileSync(tmp, `${JSON.stringify(file, null, "\t")}\n`, { mode: 0o600, flag: "wx" });
			renameSync(tmp, this.path);
		} catch (err) {
			rmSync(tmp, { force: true });
			throw err;
		}
	}
}
