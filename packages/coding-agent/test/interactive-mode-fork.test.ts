/**
 * Unit coverage for the interactive `/fork` selector wiring
 * (InteractiveMode.showUserMessageSelector).
 *
 * Exercised without a full TUI: the selector component is mocked to capture the
 * onSelect callback, and the method is invoked via prototype.call with a
 * hand-built `this` (the same pattern as interactive-mode-status.test.ts).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// Capture every UserMessageSelectorComponent construction so tests can drive the
// onSelect callback and assert the items list (incl. the fork-from-current row).
const captured: Array<{
	items: Array<{ id: string; text: string; isAction?: boolean }>;
	onSelect: (entryId: string) => void | Promise<void>;
	onCancel: () => void;
}> = [];

vi.mock("../src/modes/interactive/components/user-message-selector.js", async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>();
	class MockUserMessageSelectorComponent {
		constructor(
			public items: Array<{ id: string; text: string; isAction?: boolean }>,
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

import { FORK_FROM_CURRENT_ID } from "../src/modes/interactive/components/user-message-selector.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";

interface FakeOverrides {
	userMessages?: Array<{ entryId: string; text: string }>;
	leafId?: string | null;
	forkFromCurrentResult?: { cancelled: boolean };
	forkResult?: { cancelled: boolean; selectedText: string };
}

function makeFakeThis(overrides: FakeOverrides = {}) {
	const done = vi.fn();
	const fake = {
		session: {
			getUserMessagesForForking: vi.fn(() => overrides.userMessages ?? []),
			forkFromCurrent: vi.fn(async () => overrides.forkFromCurrentResult ?? { cancelled: false }),
			fork: vi.fn(async () => overrides.forkResult ?? { cancelled: false, selectedText: "prefill" }),
		},
		sessionManager: { getLeafId: vi.fn(() => overrides.leafId ?? null) },
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

describe("InteractiveMode.showUserMessageSelector — fork-from-current wiring", () => {
	beforeEach(() => {
		captured.length = 0;
	});

	it("appends the fork-from-current action row when there is a current leaf", () => {
		const fake = makeFakeThis({
			userMessages: [
				{ entryId: "u1", text: "first" },
				{ entryId: "u2", text: "second" },
			],
			leafId: "a2",
		});
		invoke(fake);

		expect(fake.showSelector).toHaveBeenCalledOnce();
		expect(captured).toHaveLength(1);
		const { items } = captured[0];
		// History messages first, then the trailing action row.
		expect(items.map((i) => i.id)).toEqual(["u1", "u2", FORK_FROM_CURRENT_ID]);
		const action = items.at(-1)!;
		expect(action.isAction).toBe(true);
		expect(action.text.toLowerCase()).toContain("current state");
	});

	it("omits the action row and shows nothing to fork when there is no leaf and no messages", () => {
		const fake = makeFakeThis({ userMessages: [], leafId: null });
		invoke(fake);

		expect(fake.showSelector).not.toHaveBeenCalled();
		expect(fake.showStatus).toHaveBeenCalledWith("No messages to fork from");
	});

	it("still offers the action row when there is a leaf but no user messages", () => {
		const fake = makeFakeThis({ userMessages: [], leafId: "a1" });
		invoke(fake);

		expect(fake.showSelector).toHaveBeenCalledOnce();
		expect(captured[0].items.map((i) => i.id)).toEqual([FORK_FROM_CURRENT_ID]);
	});

	it("routes the action row to forkFromCurrent() and resets the editor on success", async () => {
		const fake = makeFakeThis({
			userMessages: [{ entryId: "u1", text: "first" }],
			leafId: "a1",
			forkFromCurrentResult: { cancelled: false },
		});
		invoke(fake);

		await captured[0].onSelect(FORK_FROM_CURRENT_ID);

		expect(fake.session.forkFromCurrent).toHaveBeenCalledOnce();
		expect(fake.session.fork).not.toHaveBeenCalled();
		expect(fake.resetChatDisplay).toHaveBeenCalledOnce();
		expect(fake.editor.setText).toHaveBeenCalledWith(""); // no re-ask pre-fill
		expect(fake._done).toHaveBeenCalledOnce();
		expect(fake.showStatus).toHaveBeenCalledWith("Branched to new session (including last response)");
	});

	it("informs the user and does not reset the editor when forkFromCurrent is cancelled", async () => {
		const fake = makeFakeThis({
			userMessages: [{ entryId: "u1", text: "first" }],
			leafId: "a1",
			forkFromCurrentResult: { cancelled: true },
		});
		invoke(fake);

		await captured[0].onSelect(FORK_FROM_CURRENT_ID);

		expect(fake.session.forkFromCurrent).toHaveBeenCalledOnce();
		expect(fake.resetChatDisplay).not.toHaveBeenCalled();
		expect(fake.editor.setText).not.toHaveBeenCalled();
		expect(fake._done).toHaveBeenCalledOnce();
		expect(fake.showStatus).toHaveBeenCalledWith("Fork cancelled — no new branch was created");
	});

	it("routes a history message to fork() and pre-fills the editor with the selected text", async () => {
		const fake = makeFakeThis({
			userMessages: [{ entryId: "u1", text: "first" }],
			leafId: "a1",
			forkResult: { cancelled: false, selectedText: "first" },
		});
		invoke(fake);

		await captured[0].onSelect("u1");

		expect(fake.session.fork).toHaveBeenCalledWith("u1");
		expect(fake.session.forkFromCurrent).not.toHaveBeenCalled();
		expect(fake.editor.setText).toHaveBeenCalledWith("first");
		expect(fake.showStatus).toHaveBeenCalledWith("Branched to new session");
	});
});
