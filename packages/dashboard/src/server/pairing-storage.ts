/**
 * File-backed pairing storage — persists paired devices under the dreb agent
 * dir so pairings survive dashboard restarts. Written with mode 0600.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

interface StoredPairing {
	id: string;
	identity: string;
	device?: string;
	createdAt: string;
	expiresAt: string;
	tokenHmac: string;
}

interface PairingFile {
	version: 1;
	pairings: StoredPairing[];
}

export class FilePairingStorage {
	constructor(private readonly path: string) {}

	async load(): Promise<StoredPairing[]> {
		let raw: string;
		try {
			raw = readFileSync(this.path, "utf8");
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw err;
		}
		const parsed = JSON.parse(raw) as PairingFile;
		if (parsed.version !== 1 || !Array.isArray(parsed.pairings)) {
			throw new Error(`Unrecognized pairing file format at ${this.path}`);
		}
		return parsed.pairings;
	}

	async save(pairings: StoredPairing[]): Promise<void> {
		mkdirSync(dirname(this.path), { recursive: true });
		const file: PairingFile = { version: 1, pairings };
		writeFileSync(this.path, `${JSON.stringify(file, null, "\t")}\n`, { mode: 0o600 });
	}
}
