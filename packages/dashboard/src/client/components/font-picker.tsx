import { createEffect, createSignal, createUniqueId, For, type JSX, onCleanup, Show } from "solid-js";
import { FONT_GROUPS, FONTS, type FontId, font, fontGroup, fontStack, setFont, theme } from "../state/appearance.js";

/** Select-only combobox: focus stays on the trigger; highlight is not commitment. */
export function FontPicker(): JSX.Element {
	const uid = createUniqueId();
	const listId = `font-list-${uid}`;
	const selectedSourceId = `font-selected-source-${uid}`;
	const optionId = (id: FontId) => `${listId}-${id}`;
	const [open, setOpen] = createSignal(false);
	const [active, setActive] = createSignal(0);
	// Stay out of document flow even before the first positioning calculation.
	const [position, setPosition] = createSignal<JSX.CSSProperties>({ position: "fixed" });
	const options = new Map<FontId, HTMLButtonElement>();
	const [previewed, setPreviewed] = createSignal<ReadonlySet<FontId>>(new Set());
	const canObserve = typeof IntersectionObserver !== "undefined";
	let wrapper!: HTMLDivElement;
	let trigger!: HTMLButtonElement;
	let popup: HTMLDivElement | undefined;
	let prefix = "";
	let typedAt = 0;

	const selected = () => FONTS.find((entry) => entry.id === font())!;
	const close = () => {
		setOpen(false);
		prefix = "";
	};
	const positionPopup = () => {
		if (!open()) return;
		const rect = trigger.getBoundingClientRect();
		// Background page scrolling must not leave an expanded menu offscreen.
		if (rect.bottom < 0 || rect.top >= window.innerHeight) {
			close();
			return;
		}
		const width = Math.min(360, Math.max(0, window.innerWidth - 16));
		const below = Math.max(0, window.innerHeight - rect.bottom - 12);
		const above = Math.max(0, rect.top - 12);
		const upwards = below < 220 && above > below;
		setPosition({
			position: "fixed",
			width: `${width}px`,
			left: `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`,
			"max-height": `${Math.min(400, upwards ? above : below)}px`,
			top: upwards ? undefined : `${rect.bottom + 4}px`,
			bottom: upwards ? `${window.innerHeight - rect.top + 4}px` : undefined,
		});
	};
	const reveal = (index = FONTS.findIndex((entry) => entry.id === font())) => {
		// Safari does not focus buttons on pointer activation by default.
		trigger.focus({ preventScroll: true });
		setActive(index);
		setOpen(true);
		positionPopup();
	};
	const commit = (id: FontId) => {
		setFont(id);
		close();
		trigger.focus();
	};

	createEffect(() => {
		// Track cross-tab/programmatic preference changes, without resetting arrow navigation.
		const index = FONTS.findIndex((entry) => entry.id === font());
		setActive(index);
	});
	createEffect(() => {
		const id = FONTS[active()].id;
		if (open())
			queueMicrotask(() => {
				if (open()) options.get(id)?.scrollIntoView?.({ block: "nearest" });
			});
	});

	// Keep every option accessible, but request typefaces only near the visible
	// scroll window. Previously previewed faces remain warm across reopening.
	createEffect(() => {
		if (!open() || !canObserve) return;
		let disposed = false;
		let observer: IntersectionObserver | undefined;
		onCleanup(() => {
			disposed = true;
			observer?.disconnect();
		});
		queueMicrotask(() => {
			if (disposed || !popup) return;
			observer = new IntersectionObserver(
				(entries) => {
					const visible = entries.filter((entry) => entry.isIntersecting);
					if (visible.length === 0) return;
					setPreviewed((previous) => {
						const next = new Set(previous);
						for (const entry of visible) {
							next.add((entry.target as HTMLElement).dataset.fontOption as FontId);
							observer?.unobserve(entry.target);
						}
						return next;
					});
				},
				{ root: popup, rootMargin: "40px" },
			);
			for (const element of options.values()) observer.observe(element);
		});
	});

	const onKeyDown: JSX.EventHandler<HTMLButtonElement, KeyboardEvent> = (event) => {
		if (event.altKey || event.ctrlKey || event.metaKey) return;
		const key = event.key;
		if (key === "Tab") {
			close();
			return;
		}
		if (key === "Escape") {
			if (open()) {
				event.preventDefault();
				event.stopPropagation();
				close();
			}
			return;
		}
		if (key === "Enter" || key === " ") {
			event.preventDefault();
			if (open()) commit(FONTS[active()].id);
			else reveal();
			return;
		}
		if (["ArrowDown", "ArrowUp", "Home", "End"].includes(key)) {
			event.preventDefault();
			prefix = "";
			if (!open()) reveal();
			else if (key === "ArrowDown") setActive((active() + 1) % FONTS.length);
			else if (key === "ArrowUp") setActive((active() + FONTS.length - 1) % FONTS.length);
			if (key === "Home") setActive(0);
			if (key === "End") setActive(FONTS.length - 1);
			return;
		}
		if (key.length !== 1 || !/\S/.test(key)) return;
		event.preventDefault();
		if (!open()) reveal();
		const now = Date.now();
		prefix = now - typedAt < 700 ? prefix + key.toLowerCase() : key.toLowerCase();
		typedAt = now;
		const cycle = [...prefix].every((char) => char === prefix[0]);
		const query = cycle ? prefix[0] : prefix;
		const start = cycle ? active() + 1 : active();
		for (let offset = 0; offset < FONTS.length; offset++) {
			const index = (start + offset) % FONTS.length;
			const entry = FONTS[index];
			if (entry.label.toLowerCase().startsWith(query) || entry.sourceLabel?.toLowerCase().startsWith(query)) {
				setActive(index);
				break;
			}
		}
	};

	createEffect(() => {
		if (!open()) return;
		const outside = (event: PointerEvent) => {
			if (!wrapper.contains(event.target as Node)) close();
		};
		const scroll = (event: Event) => {
			if (!popup?.contains(event.target as Node)) positionPopup();
		};
		document.addEventListener("pointerdown", outside);
		window.addEventListener("resize", positionPopup);
		window.addEventListener("scroll", scroll, true);
		onCleanup(() => {
			document.removeEventListener("pointerdown", outside);
			window.removeEventListener("resize", positionPopup);
			window.removeEventListener("scroll", scroll, true);
			options.clear();
		});
	});

	return (
		<div
			class="font-picker"
			ref={wrapper}
			onFocusOut={(event) => {
				if (!wrapper.contains(event.relatedTarget as Node | null)) close();
			}}
		>
			<button
				ref={trigger}
				type="button"
				id="pref-font"
				role="combobox"
				aria-label="font"
				aria-describedby={selected().sourceLabel ? selectedSourceId : undefined}
				aria-haspopup="listbox"
				aria-expanded={open()}
				aria-controls={open() ? listId : undefined}
				aria-activedescendant={open() ? optionId(FONTS[active()].id) : undefined}
				class="font-picker-trigger"
				data-font-value={font()}
				style={{ "font-family": fontStack(font(), theme()) }}
				on:keydown={onKeyDown}
				onClick={() => {
					if (open()) close();
					else reveal();
				}}
			>
				<span class="font-picker-text">
					<span class="font-picker-name">{selected().label}</span>
					<Show when={selected().sourceLabel}>
						<span class="font-picker-source" id={selectedSourceId}>
							Based on {selected().sourceLabel}
						</span>
					</Show>
				</span>
				<span aria-hidden="true">▾</span>
			</button>
			<Show when={open()}>
				<div
					ref={popup}
					class="font-picker-list"
					role="listbox"
					id={listId}
					aria-label="font choices"
					style={position()}
				>
					<For each={FONT_GROUPS}>
						{(group) => (
							<fieldset aria-label={group === "Existing choices" ? group : `${group} fonts`}>
								<legend class="font-picker-group" onPointerDown={(event) => event.preventDefault()}>
									{group === "Existing choices" ? group : `${group} fonts`}
								</legend>
								<For each={FONTS.filter((entry) => fontGroup(entry.id) === group)}>
									{(entry) => (
										<button
											ref={(element) => {
												options.set(entry.id, element);
											}}
											type="button"
											role="option"
											tabIndex={-1}
											id={optionId(entry.id)}
											data-font-option={entry.id}
											aria-selected={font() === entry.id}
											aria-label={entry.label}
											aria-describedby={entry.sourceLabel ? `${optionId(entry.id)}-source` : undefined}
											class="font-picker-option"
											classList={{ highlighted: FONTS[active()].id === entry.id }}
											style={{
												"font-family":
													!canObserve || previewed().has(entry.id)
														? fontStack(entry.id, theme())
														: undefined,
											}}
											onPointerDown={(event) => event.preventDefault()}
											onPointerMove={() =>
												setActive(FONTS.findIndex((candidate) => candidate.id === entry.id))
											}
											onClick={() => commit(entry.id)}
										>
											<Show
												when={entry.sourceLabel}
												fallback={<span class="font-picker-name">{entry.label}</span>}
											>
												<span class="font-picker-text">
													<span class="font-picker-name">{entry.label}</span>
													<span class="font-picker-source" id={`${optionId(entry.id)}-source`}>
														Based on {entry.sourceLabel}
													</span>
												</span>
											</Show>
											<span aria-hidden="true">{font() === entry.id ? "✓" : ""}</span>
										</button>
									)}
								</For>
							</fieldset>
						)}
					</For>
				</div>
			</Show>
		</div>
	);
}
