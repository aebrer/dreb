import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * SPEC.md §9.9: tokens.css is adopted unmodified. The client's copy must stay
 * byte-identical to the design source — extensions live in separate files;
 * overriding a token is a design change that requires a SPEC update.
 */
describe("tokens.css design contract", () => {
	it("client copy is byte-identical to design/dashboard/tokens.css", () => {
		const designPath = join(import.meta.dirname, "..", "..", "..", "design", "dashboard", "tokens.css");
		const clientPath = join(import.meta.dirname, "..", "src", "client", "styles", "tokens.css");
		const design = readFileSync(designPath, "utf8");
		const client = readFileSync(clientPath, "utf8");
		expect(client).toBe(design);
	});
});
