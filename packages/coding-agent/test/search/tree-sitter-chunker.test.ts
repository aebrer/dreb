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
// TSX
// ============================================================================

const tsxCode = `export function MyComponent() {
  return <div>hello</div>;
}
`;

describe("chunkWithTreeSitter — TSX", () => {
	let chunks: Chunk[];

	beforeAll(async () => {
		chunks = await chunkWithTreeSitter(tsxCode, "component.tsx", "tsx");
	});

	it("extracts MyComponent function", () => {
		const fn = chunks.find((c) => c.name === "MyComponent");
		expect(fn).toBeDefined();
		expect(["function", "export"]).toContain(fn!.kind);
		expect(fn!.content).toContain("MyComponent");
	});

	it("has correct line range", () => {
		const fn = chunks.find((c) => c.name === "MyComponent");
		expect(fn!.startLine).toBeGreaterThan(0);
		expect(fn!.endLine).toBeGreaterThanOrEqual(fn!.startLine);
	});
});

// ============================================================================
// JavaScript
// ============================================================================

const jsCode = `function greet(name) {
  return 'hello ' + name;
}

const handler = (req, res) => {
  res.send('ok');
};
`;

describe("chunkWithTreeSitter — JavaScript", () => {
	let chunks: Chunk[];

	beforeAll(async () => {
		chunks = await chunkWithTreeSitter(jsCode, "app.js", "javascript");
	});

	it("extracts greet function_declaration", () => {
		const fn = chunks.find((c) => c.name === "greet");
		expect(fn).toBeDefined();
		expect(fn!.kind).toBe("function");
		expect(fn!.content).toContain("greet");
	});

	it("extracts handler arrow_function", () => {
		const fn = chunks.find((c) => c.name === "handler");
		expect(fn).toBeDefined();
		expect(fn!.kind).toBe("function");
		expect(fn!.content).toContain("res.send");
	});

	it("each chunk has valid line range and non-empty content", () => {
		for (const chunk of chunks) {
			expect(chunk.startLine).toBeGreaterThan(0);
			expect(chunk.endLine).toBeGreaterThanOrEqual(chunk.startLine);
			expect(chunk.content.length).toBeGreaterThan(0);
		}
	});
});

// ============================================================================
// Rust
// ============================================================================

const rustCode = `fn main() {
    println!("hello");
}

struct Point {
    x: f64,
    y: f64,
}

impl Point {
    fn new(x: f64, y: f64) -> Self {
        Point { x, y }
    }
}
`;

describe("chunkWithTreeSitter — Rust", () => {
	let chunks: Chunk[];

	beforeAll(async () => {
		chunks = await chunkWithTreeSitter(rustCode, "main.rs", "rust");
	});

	it("extracts main function", () => {
		const fn = chunks.find((c) => c.name === "main");
		expect(fn).toBeDefined();
		expect(fn!.kind).toBe("function");
		expect(fn!.content).toContain("println!");
	});

	it("extracts Point struct", () => {
		const s = chunks.find((c) => c.name === "Point" && c.kind === "struct");
		expect(s).toBeDefined();
		expect(s!.content).toContain("x: f64");
	});

	it("extracts Point impl", () => {
		const impl = chunks.find((c) => c.name === "Point" && c.kind === "impl");
		expect(impl).toBeDefined();
		expect(impl!.content).toContain("fn new");
	});

	it("each chunk has valid line range", () => {
		for (const chunk of chunks) {
			expect(chunk.startLine).toBeGreaterThan(0);
			expect(chunk.endLine).toBeGreaterThanOrEqual(chunk.startLine);
		}
	});
});

// ============================================================================
// Java
// ============================================================================

const javaCode = `public class Greeting {
    public String greet(String name) {
        return "Hello " + name;
    }
}
`;

describe("chunkWithTreeSitter — Java", () => {
	let chunks: Chunk[];

	beforeAll(async () => {
		chunks = await chunkWithTreeSitter(javaCode, "Greeting.java", "java");
	});

	it("extracts Greeting class", () => {
		const cls = chunks.find((c) => c.name === "Greeting");
		expect(cls).toBeDefined();
		expect(cls!.kind).toBe("class");
		expect(cls!.content).toContain("Greeting");
	});

	it("class chunk encompasses the method", () => {
		// Java class_declaration is the outermost node; method is nested inside
		const cls = chunks.find((c) => c.name === "Greeting");
		expect(cls).toBeDefined();
		expect(cls!.content).toContain("greet");
		expect(cls!.content).toContain("Hello");
	});

	it("each chunk has valid line range and non-empty content", () => {
		for (const chunk of chunks) {
			expect(chunk.startLine).toBeGreaterThan(0);
			expect(chunk.endLine).toBeGreaterThanOrEqual(chunk.startLine);
			expect(chunk.content.length).toBeGreaterThan(0);
		}
	});
});

// ============================================================================
// C
// ============================================================================

const cCode = `int add(int a, int b) {
    return a + b;
}

struct Point {
    int x;
    int y;
};
`;

describe("chunkWithTreeSitter — C", () => {
	let chunks: Chunk[];

	beforeAll(async () => {
		chunks = await chunkWithTreeSitter(cCode, "math.c", "c");
	});

	it("extracts add function", () => {
		const fn = chunks.find((c) => c.name === "add");
		expect(fn).toBeDefined();
		expect(fn!.kind).toBe("function");
		expect(fn!.content).toContain("return a + b");
	});

	it("extracts Point struct", () => {
		const s = chunks.find((c) => c.name === "Point");
		expect(s).toBeDefined();
		expect(s!.kind).toBe("struct");
		expect(s!.content).toContain("int x");
	});

	it("each chunk has valid line range", () => {
		for (const chunk of chunks) {
			expect(chunk.startLine).toBeGreaterThan(0);
			expect(chunk.endLine).toBeGreaterThanOrEqual(chunk.startLine);
		}
	});
});

// ============================================================================
// C++
// ============================================================================

const cppCode = `class Calculator {
public:
    int add(int a, int b) {
        return a + b;
    }
};

int main() {
    return 0;
}
`;

describe("chunkWithTreeSitter — C++", () => {
	let chunks: Chunk[];

	beforeAll(async () => {
		chunks = await chunkWithTreeSitter(cppCode, "calc.cpp", "cpp");
	});

	it("extracts Calculator class", () => {
		const cls = chunks.find((c) => c.name === "Calculator");
		expect(cls).toBeDefined();
		expect(cls!.kind).toBe("class");
		expect(cls!.content).toContain("Calculator");
	});

	it("extracts main function", () => {
		const fn = chunks.find((c) => c.name === "main");
		expect(fn).toBeDefined();
		expect(fn!.kind).toBe("function");
		expect(fn!.content).toContain("return 0");
	});

	it("each chunk has valid line range and non-empty content", () => {
		for (const chunk of chunks) {
			expect(chunk.startLine).toBeGreaterThan(0);
			expect(chunk.endLine).toBeGreaterThanOrEqual(chunk.startLine);
			expect(chunk.content.length).toBeGreaterThan(0);
		}
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
