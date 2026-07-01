import { describe, expect, it } from "vitest";
import { SessionApi, type SessionLister } from "../src/sessions.js";

const session = {
	path: "/tmp/session.jsonl",
	id: "s1",
	cwd: "/tmp/project",
	created: new Date("2026-01-01T00:00:00.000Z"),
	modified: new Date("2026-01-02T00:00:00.000Z"),
	messageCount: 1,
	firstMessage: "hello",
	allMessagesText: "hello",
};

describe("SessionApi", () => {
	it("lists all and project sessions through the injected lister", async () => {
		const calls: string[] = [];
		const lister: SessionLister = {
			listAll: async () => {
				calls.push("all");
				return [session];
			},
			listProject: async (cwd) => {
				calls.push(cwd);
				return [session];
			},
		};
		const api = new SessionApi(lister);

		await expect(api.listAll()).resolves.toEqual([
			{ ...session, created: "2026-01-01T00:00:00.000Z", modified: "2026-01-02T00:00:00.000Z" },
		]);
		await expect(api.listProject("/tmp/project")).resolves.toHaveLength(1);
		expect(calls).toEqual(["all", "/tmp/project"]);
	});
});
