import { execSync, spawn } from "child_process";
import { platform } from "os";
import { isWaylandSession } from "./clipboard-image.js";
import { clipboard } from "./clipboard-native.js";

type NativeClipboardExecOptions = {
	input: string;
	timeout: number;
	stdio: ["pipe", "ignore", "ignore"];
};

function copyToX11Clipboard(options: NativeClipboardExecOptions): void {
	try {
		execSync("xclip -selection clipboard", options);
	} catch {
		// xclip unavailable — fall back to xsel
		execSync("xsel --clipboard --input", options);
	}
}

export type ClipboardResult = { method: "native" | "platform" | "osc52" };

/**
 * Best-effort write to the native clipboard module. Returns true on success.
 *
 * On Linux this is the source of issue 286: the native module (clipboard-rs)
 * uses an X11 backend whose in-process selection-serving thread calls
 * `println!("Somebody else owns the clipboard now")` (clipboard-rs
 * src/platform/x11.rs) on `SelectionClear` — i.e. whenever another app takes
 * the clipboard. That write goes to the real stdout file descriptor from native
 * code, so no JS-level stdout/stderr guard can intercept it; it lands in the TUI
 * input region. Callers therefore use this only where it is safe (macOS/Windows,
 * which have no serving thread) or as a Linux last resort when no CLI clipboard
 * tool exists.
 */
async function tryNativeClipboard(text: string): Promise<boolean> {
	try {
		if (clipboard) {
			await clipboard.setText(text);
			return true;
		}
	} catch {
		/* Native clipboard module threw — caller falls through to other methods */
	}
	return false;
}

export async function copyToClipboard(text: string): Promise<ClipboardResult> {
	// Always emit OSC 52 - works over SSH/mosh, harmless locally
	const encoded = Buffer.from(text).toString("base64");
	process.stdout.write(`\x1b]52;c;${encoded}\x07`);

	const p = platform();

	// On macOS/Windows the native module talks to OS clipboard APIs directly and
	// does not spawn a background selection-serving thread, so prefer it there.
	// On Linux we intentionally do NOT try the native module first — see
	// tryNativeClipboard for why (issue 286) — and prefer controlled-stdio
	// subprocess tools instead, falling back to native only as a last resort.
	if (p !== "linux") {
		if (await tryNativeClipboard(text)) {
			return { method: "native" };
		}
	}

	const options: NativeClipboardExecOptions = { input: text, timeout: 5000, stdio: ["pipe", "ignore", "ignore"] };

	try {
		if (p === "darwin") {
			execSync("pbcopy", options);
			return { method: "platform" };
		} else if (p === "win32") {
			execSync("clip", options);
			return { method: "platform" };
		} else {
			// Linux. Prefer controlled-stdio subprocess tools (Termux, Wayland,
			// X11). Each owns the selection in its own process with stdout/stderr
			// redirected to /dev/null, so its clipboard-ownership chatter cannot
			// leak into the TUI — unlike the in-process native module (issue 286).
			if (process.env.TERMUX_VERSION) {
				try {
					execSync("termux-clipboard-set", options);
					return { method: "platform" };
				} catch {
					/* termux-clipboard-set unavailable — fall back to Wayland or X11 tools */
				}
			}

			const hasWaylandDisplay = Boolean(process.env.WAYLAND_DISPLAY);
			const hasX11Display = Boolean(process.env.DISPLAY);
			const isWayland = isWaylandSession();
			if (isWayland && hasWaylandDisplay) {
				try {
					// Verify wl-copy exists (spawn errors are async and won't be caught)
					execSync("which wl-copy", { stdio: "ignore" });
					// wl-copy with execSync hangs due to fork behavior; use spawn instead.
					// detached: true puts wl-copy in its own session (setsid) so it keeps
					// serving the clipboard after we exit and has no controlling terminal.
					const proc = spawn("wl-copy", [], { stdio: ["pipe", "ignore", "ignore"], detached: true });
					proc.on("error", () => {
						// Spawn failed after which check (TOCTOU, permissions, etc.)
					});
					proc.stdin.on("error", () => {
						// Ignore EPIPE errors if wl-copy exits early
					});
					proc.stdin.write(text);
					proc.stdin.end();
					proc.unref();
					// Can't confirm wl-copy succeeded before unref — report osc52 (already emitted above)
					return { method: "osc52" };
				} catch {
					/* wl-copy unavailable or failed — fall back to X11 if available */
					if (hasX11Display) {
						copyToX11Clipboard(options);
						return { method: "platform" };
					}
				}
			} else if (hasX11Display) {
				copyToX11Clipboard(options);
				return { method: "platform" };
			}

			// Linux last resort: the native module. Only reached when no CLI
			// clipboard tool is available. This can reintroduce the issue-286
			// stdout leak on X11 ownership changes, but a working clipboard beats
			// none, and OSC 52 was already emitted above regardless.
			if (await tryNativeClipboard(text)) {
				return { method: "native" };
			}
		}
	} catch {
		/* Platform clipboard tools failed — OSC 52 already emitted above as fallback */
	}

	return { method: "osc52" };
}
