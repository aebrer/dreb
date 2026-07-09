/**
 * File-backed pairing storage — persists paired devices under the dreb agent
 * dir so pairings survive dashboard restarts. Written with mode 0600.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { PairingState, StoredPairing } from "./auth.js";

interface PairingFile {
	version: 1;
	pairings: StoredPairing[];
	consumedPairingWindows?: number[];
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
			parsed.version !== 1 ||
			!Array.isArray(parsed.pairings) ||
			(parsed.consumedPairingWindows !== undefined &&
				(!Array.isArray(parsed.consumedPairingWindows) ||
					!parsed.consumedPairingWindows.every((window) => Number.isSafeInteger(window))))
		) {
			throw new Error(`Unrecognized pairing file format at ${this.path}`);
		}
		return {
			pairings: parsed.pairings,
			consumedPairingWindows: parsed.consumedPairingWindows ?? [],
		};
	}

	async save(state: PairingState): Promise<void> {
		const dir = dirname(this.path);
		mkdirSync(dir, { recursive: true });
		const file: PairingFile = { version: 1, ...state };
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
