import { beforeAll, describe, expect, it } from "vitest";
import { chunkWithTreeSitter, initTreeSitter } from "../../src/core/search/tree-sitter-chunker.js";
import type { Chunk } from "../../src/core/search/types.js";

// ============================================================================
// Setup
// ============================================================================

beforeAll(async () => {
	await initTreeSitter();
});

// ============================================================================
// TypeScript
// ============================================================================

const tsCode = `
export function authenticate(user: string, pass: string): boolean {
  return checkCredentials(user, pass);
}

export class AuthService {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  async login(user: string): Promise<Token> {
    return this.db.findUser(user);
  }
}

export interface AuthConfig {
  secret: string;
  ttl: number;
}

const helper = () => {
  return 42;
};
`;

describe("chunkWithTreeSitter — TypeScript", () => {
	let chunks: Chunk[];

	beforeAll(async () => {
		chunks = await chunkWithTreeSitter(tsCode, "auth.ts", "typescript");
	});

	it("extracts the authenticate function", () => {
		const fn = chunks.find((c) => c.name === "authenticate");
		expect(fn).toBeDefined();
		// `export function` is captured as an export_statement wrapping the function
		expect(["function", "export"]).toContain(fn!.kind);
		expect(fn!.content).toContain("authenticate");
		expect(fn!.startLine).toBeGreaterThan(0);
		expect(fn!.endLine).toBeGreaterThanOrEqual(fn!.startLine);
	});

	it("extracts the AuthService class", () => {
		const cls = chunks.find((c) => c.name === "AuthService");
		expect(cls).toBeDefined();
		// `export class` is captured as an export_statement wrapping the class
		expect(["class", "export"]).toContain(cls!.kind);
		expect(cls!.content).toContain("AuthService");
	});

	it("extracts the AuthConfig interface", () => {
		const iface = chunks.find((c) => c.name === "AuthConfig");
		expect(iface).toBeDefined();
		// `export interface` is captured as an export_statement wrapping the interface
		expect(["interface", "export"]).toContain(iface!.kind);
		expect(iface!.content).toContain("secret");
	});

	it("extracts the helper arrow function", () => {
		const arrow = chunks.find((c) => c.name === "helper");
		expect(arrow).toBeDefined();
		// Non-exported arrow function assigned to a variable
		expect(["function", "export"]).toContain(arrow!.kind);
		expect(arrow!.content).toContain("42");
	});

	it("each chunk has correct startLine/endLine and non-empty content", () => {
		for (const chunk of chunks) {
			expect(chunk.startLine).toBeGreaterThan(0);
			expect(chunk.endLine).toBeGreaterThanOrEqual(chunk.startLine);
			expect(chunk.content.length).toBeGreaterThan(0);
		}
	});

	it("chunk names match the symbol names", () => {
		const names = chunks.filter((c) => c.name !== null).map((c) => c.name);
		expect(names).toContain("authenticate");
		expect(names).toContain("AuthService");
		expect(names).toContain("AuthConfig");
		expect(names).toContain("helper");
	});
});

// ============================================================================
// Python
// ============================================================================

const pyCode = `def process_data(items):
    return [transform(x) for x in items]

class DataProcessor:
    def __init__(self, config):
        self.config = config

    def run(self):
        pass
`;

describe("chunkWithTreeSitter — Python", () => {
	let chunks: Chunk[];

	beforeAll(async () => {
		chunks = await chunkWithTreeSitter(pyCode, "processor.py", "python");
	});

	it("extracts process_data function", () => {
		const fn = chunks.find((c) => c.name === "process_data");
		expect(fn).toBeDefined();
		expect(fn!.kind).toBe("function");
		expect(fn!.content).toContain("process_data");
	});

	it("extracts DataProcessor class", () => {
		const cls = chunks.find((c) => c.name === "DataProcessor");
		expect(cls).toBeDefined();
		expect(cls!.kind).toBe("class");
		expect(cls!.content).toContain("DataProcessor");
	});
});

// ============================================================================
// Go
// ============================================================================

const goCode = `package auth

func Authenticate(user string) bool {
    return true
}

type Config struct {
    Secret string
}
`;

describe("chunkWithTreeSitter — Go", () => {
	let chunks: Chunk[];

	beforeAll(async () => {
		chunks = await chunkWithTreeSitter(goCode, "auth.go", "go");
	});

	it("extracts Authenticate function", () => {
		const fn = chunks.find((c) => c.name === "Authenticate");
		expect(fn).toBeDefined();
		expect(fn!.kind).toBe("function");
		expect(fn!.content).toContain("Authenticate");
	});

	it("extracts Config type", () => {
		const typ = chunks.find((c) => c.name === "Config");
		expect(typ).toBeDefined();
		expect(typ!.kind).toBe("struct");
		expect(typ!.content).toContain("Secret");
	});
});

// ============================================================================
// Fallback — invalid/unparseable code
// ============================================================================

describe("chunkWithTreeSitter — fallback for unparseable code", () => {
	it("returns a single file chunk for gibberish content", async () => {
		// Content with no recognizable constructs in any language
		const gibberish = "@@@ %%% ^^^ this is not valid code @#$\n!!!\n???\n";
		const chunks = await chunkWithTreeSitter(gibberish, "unknown.ts", "typescript");

		expect(chunks).toHaveLength(1);
		expect(chunks[0].kind).toBe("file");
		expect(chunks[0].content).toBe(gibberish);
		expect(chunks[0].filePath).toBe("unknown.ts");
	});
});
