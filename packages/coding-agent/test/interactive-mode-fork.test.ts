/**
 * Unit coverage for the interactive `/fork` selector wiring
 * (InteractiveMode.showUserMessageSelector).
 *
 * Any user or assistant message is a fork point — there is no separate
 * "fork from current state" action row. Exercised without a full TUI: the
 * selector component is mocked to capture the onSelect callback, and the method
 * is invoked via prototype.call with a hand-built `this` (the same pattern as
 * interactive-mode-status.test.ts).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// Capture every UserMessageSelectorComponent construction so tests can drive the
// onSelect callback and assert the items list (role-labeled, all messages).
const captured: Array<{
	items: Array<{ id: string; text: string; role: "user" | "assistant" }>;
	onSelect: (entryId: string) => void | Promise<void>;
	onCancel: () => void;
}> = [];

vi.mock("../src/modes/interactive/components/user-message-selector.js", async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>();
	class MockUserMessageSelectorComponent {
		constructor(
			public items: Array<{ id: string; text: string; role: "user" | "assistant" }>,
			public onSelect: (entryId: string) => void | Promise<void>,
			public onCancel: () => void,
		) {
			captured.push({ items, onSelect, onCancel });
		}
		getMessageList() {
			return {};
		}
	}
	return { ...actual, UserMessageSelectorComponent: MockUserMessageSelectorComponent };
});

import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";

interface FakeOverrides {
	messages?: Array<{ entryId: string; text: string; role: "user" | "assistant" }>;
	forkResult?: { cancelled: boolean; selectedText: string };
	forkThrows?: Error;
}

function makeFakeThis(overrides: FakeOverrides = {}) {
	const done = vi.fn();
	const fake = {
		session: {
			getForkableMessages: vi.fn(() => overrides.messages ?? []),
			fork: vi.fn(async () => {
				if (overrides.forkThrows) throw overrides.forkThrows;
				return overrides.forkResult ?? { cancelled: false, selectedText: "prefill" };
			}),
		},
		showStatus: vi.fn(),
		resetChatDisplay: vi.fn(),
		editor: { setText: vi.fn() },
		ui: { requestRender: vi.fn() },
		// showSelector(builder) invokes the builder with a `done` callback and keeps
		// whatever component it returns; here we just run the builder synchronously.
		showSelector: vi.fn((builder: (done: () => void) => unknown) => builder(done)),
		_done: done,
	};
	return fake;
}

function invoke(fake: ReturnType<typeof makeFakeThis>) {
	(
		InteractiveMode as unknown as { prototype: { showUserMessageSelector: () => void } }
	).prototype.showUserMessageSelector.call(fake);
}

describe("InteractiveMode.showUserMessageSelector — fork at any message", () => {
	beforeEach(() => {
		captured.length = 0;
	});

	it("lists all user and assistant messages with their roles (no action row)", () => {
		const fake = makeFakeThis({
			messages: [
				{ entryId: "u1", text: "first", role: "user" },
				{ entryId: "a1", text: "answer", role: "assistant" },
				{ entryId: "u2", text: "second", role: "user" },
			],
		});
		invoke(fake);

		expect(fake.showSelector).toHaveBeenCalledOnce();
		expect(captured).toHaveLength(1);
		const { items } = captured[0];
		expect(items.map((i) => i.id)).toEqual(["u1", "a1", "u2"]);
		expect(items.map((i) => i.role)).toEqual(["user", "assistant", "user"]);
	});

	it("shows nothing to fork and does not open the selector when there are no messages", () => {
		const fake = makeFakeThis({ messages: [] });
		invoke(fake);

		expect(fake.showSelector).not.toHaveBeenCalled();
		expect(fake.showStatus).toHaveBeenCalledWith("No messages to fork from");
	});

	it("forking at an assistant message resets the display with no editor pre-fill", async () => {
		const fake = makeFakeThis({
			messages: [{ entryId: "a1", text: "answer", role: "assistant" }],
			forkResult: { cancelled: false, selectedText: "" },
		});
		invoke(fake);

		await captured[0].onSelect("a1");

		expect(fake.session.fork).toHaveBeenCalledWith("a1");
		expect(fake.resetChatDisplay).toHaveBeenCalledOnce();
		expect(fake.editor.setText).toHaveBeenCalledWith("");
		expect(fake._done).toHaveBeenCalledOnce();
		expect(fake.showStatus).toHaveBeenCalledWith("Branched to new session");
	});

	it("forking at a user message pre-fills the editor with the selected text", async () => {
		const fake = makeFakeThis({
			messages: [{ entryId: "u1", text: "first", role: "user" }],
			forkResult: { cancelled: false, selectedText: "first" },
		});
		invoke(fake);

		await captured[0].onSelect("u1");

		expect(fake.session.fork).toHaveBeenCalledWith("u1");
		expect(fake.editor.setText).toHaveBeenCalledWith("first");
		expect(fake.showStatus).toHaveBeenCalledWith("Branched to new session");
	});

	it("informs the user and does not reset the editor when the fork is cancelled", async () => {
		const fake = makeFakeThis({
			messages: [{ entryId: "u1", text: "first", role: "user" }],
			forkResult: { cancelled: true, selectedText: "" },
		});
		invoke(fake);

		await captured[0].onSelect("u1");

		expect(fake.resetChatDisplay).not.toHaveBeenCalled();
		expect(fake.editor.setText).not.toHaveBeenCalled();
		expect(fake._done).toHaveBeenCalledOnce();
		expect(fake.showStatus).toHaveBeenCalledWith("Fork cancelled — no new branch was created");
	});

	it("surfaces an error instead of crashing when fork() throws", async () => {
		const fake = makeFakeThis({
			messages: [{ entryId: "a1", text: "answer", role: "assistant" }],
			forkThrows: new Error("Entry not found"),
		});
		invoke(fake);

		await captured[0].onSelect("a1");

		expect(fake.resetChatDisplay).not.toHaveBeenCalled();
		expect(fake._done).toHaveBeenCalledOnce();
		expect(fake.showStatus).toHaveBeenCalledWith("Fork failed: Entry not found");
	});
});
