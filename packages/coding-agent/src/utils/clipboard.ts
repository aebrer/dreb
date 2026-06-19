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

export async function copyToClipboard(text: string): Promise<ClipboardResult> {
	// Always emit OSC 52 - works over SSH/mosh, harmless locally
	const encoded = Buffer.from(text).toString("base64");
	process.stdout.write(`\x1b]52;c;${encoded}\x07`);

	try {
		if (clipboard) {
			await clipboard.setText(text);
			return { method: "native" };
		}
	} catch {
		/* Native clipboard module threw — fall through to platform-specific tools */
	}

	// Also try native tools (best effort for local sessions)
	const p = platform();
	const options: NativeClipboardExecOptions = { input: text, timeout: 5000, stdio: ["pipe", "ignore", "ignore"] };

	try {
		if (p === "darwin") {
			execSync("pbcopy", options);
			return { method: "platform" };
		} else if (p === "win32") {
			execSync("clip", options);
			return { method: "platform" };
		} else {
			// Linux. Try Termux, Wayland, or X11 clipboard tools.
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
					// detached: true puts wl-copy in its own session (setsid) with no
					// controlling terminal, so its "Somebody else owns the clipboard now"
					// message cannot leak into the TUI even if it bypasses the ignored
					// stderr by writing to /dev/tty (see issue 286). As a session leader it
					// also keeps serving the clipboard after we exit.
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
		}
	} catch {
		/* Platform clipboard tools failed — OSC 52 already emitted above as fallback */
	}

	return { method: "osc52" };
}
