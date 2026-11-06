/** Native sorting controls shared by Fleet section/table headings, not session sidebars. */
import type { JSX } from "solid-js";
import { DEFAULT_FLEET_SORT, FLEET_SORT_OPTIONS, type FleetSortKey, isFleetDateSort } from "../state/fleet-sorting.js";
import { fleetSort, setFleetSort } from "../state/preferences.js";

type SortKey = Exclude<FleetSortKey, "default">;

export function fleetColumnSort(key: SortKey): "ascending" | "descending" | undefined {
	return fleetSort().key === key ? (fleetSort().direction === "asc" ? "ascending" : "descending") : undefined;
}

export function FleetSortHeader(props: { sortKey: SortKey; label: string }): JSX.Element {
	const active = () => fleetSort().key === props.sortKey;
	const direction = () => (fleetSort().direction === "asc" ? "ascending" : "descending");
	const name = () => FLEET_SORT_OPTIONS.find((option) => option.key === props.sortKey)!.label;
	return (
		<button
			type="button"
			class="fleet-sort-header"
			classList={{ active: active() }}
			data-sort-key={props.sortKey}
			data-sort-direction={active() ? fleetSort().direction : undefined}
			aria-pressed={active()}
			aria-label={`Sort by ${name()}${active() ? `, ${direction()}` : ""}`}
			title={`${name()}. ${active() ? `Currently ${direction()}. Click to reverse.` : "Click to sort."}`}
			onClick={() => {
				const direction = active()
					? fleetSort().direction === "asc"
						? "desc"
						: "asc"
					: isFleetDateSort(props.sortKey)
						? "desc"
						: "asc";
				setFleetSort({ key: props.sortKey, direction });
			}}
		>
			{props.label}
			<span class="fleet-sort-arrow" aria-hidden="true">
				{active() ? (fleetSort().direction === "asc" ? "↑" : "↓") : "↕"}
			</span>
		</button>
	);
}

export function FleetSortReset(): JSX.Element {
	return (
		<button
			type="button"
			class="btn btn-small fleet-sort-reset"
			aria-label="Reset Fleet sorting"
			title="Return to Default: stable live project/start order and newest-first past sessions"
			disabled={fleetSort().key === "default"}
			onClick={() => setFleetSort(DEFAULT_FLEET_SORT)}
		>
			Reset
		</button>
	);
}
