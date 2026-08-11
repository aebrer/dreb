/**
 * Dashboard-mode RPC event projection.
 *
 * `message_update` events carry two cumulative copies of the growing assistant
 * message: the top-level `message` field and `assistantMessageEvent.partial`.
 * Serializing both for every token makes the child->parent JSONL pipe quadratic
 * in response length and floods the stdout queue (see issue 448).
 *
 * The dashboard never reads those fields: its browser reducer consumes only
 * the delta fields (`delta`, `content`, `toolCall`, `contentIndex`), and its
 * authoritative transcript comes from `message_end` plus `get_dashboard_snapshot`
 * RPC responses. The dashboard's own EventHub already strips the same fields at
 * the browser SSE boundary (projectDashboardEvent); this module applies the same
 * removal one boundary earlier, before JSONL serialization in runRpcMode.
 *
 * Only the quadratic `message_update` fields are removed here. Broader bounding
 * (agent_end messages, tool_execution_update args, retry discardedPartial,
 * images) remains the EventHub's browser-facing concern.
 */

function omit(event: Record<string, unknown>, ...keys: string[]): Record<string, unknown> {
	const copy = { ...event };
	for (const key of keys) delete copy[key];
	return copy;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Project a single agent session event for dashboard-mode RPC transport.
 *
 * Unknown event types are returned exactly as received (same reference) so
 * extensions and future event types remain forward-safe. Projected events are
 * shallow copies — the input event is never mutated, because other session
 * subscribers (and the session's own state) share the same object.
 */
export function projectDashboardRpcEvent(event: Record<string, unknown>): Record<string, unknown> {
	switch (event.type) {
		case "message_update": {
			const projected = omit(event, "message");
			const streamEvent = event.assistantMessageEvent;
			return isPlainObject(streamEvent)
				? { ...projected, assistantMessageEvent: omit(streamEvent, "partial") }
				: projected;
		}
		case "background_agent_event": {
			const child = event.event;
			return isPlainObject(child) ? { ...event, event: projectDashboardRpcEvent(child) } : event;
		}
		default:
			return event;
	}
}
