import { render } from "solid-js/web";
import { Transcript } from "../../src/client/components/transcript.js";
import { setImageDisplayMode } from "../../src/client/state/preferences.js";
import type { TranscriptEntry } from "../../src/client/state/reducer.js";

const params = new URLSearchParams(window.location.search);
const mode = params.get("mode");
setImageDisplayMode(mode === "placeholders" || mode === "originals" ? mode : "previews");
const size = Number(params.get("size") ?? 4 * 1024 * 1024);
const image = { id: "a".repeat(64), mimeType: "image/png" as const, size };
const entry: TranscriptEntry =
	params.get("entry") === "user"
		? { kind: "user", text: "describe this", images: [image] }
		: {
				kind: "tool",
				toolCallId: "image",
				toolName: "read",
				args: { path: "/tmp/image.png" },
				status: "done",
				resultText: "",
				images: [image],
				startedAt: Date.now(),
			};
render(
	() => <Transcript entries={[entry]} imageScope={{ runtimeKey: "browser-runtime" }} />,
	document.querySelector("#app")!,
);
