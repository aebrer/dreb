#!/usr/bin/env node

import { pathToFileURL } from "node:url";

/**
 * Opt-in, payload-free dashboard transport profiler. It records only response
 * sizes, timings, SSE event types, and burst aggregates; event payloads are
 * parsed transiently and never added to the output.
 */

const DEFAULT_DURATION_SECONDS = 60;
const DEFAULT_FLEET_SAMPLES = 1;
const DEFAULT_BURST_GAP_MS = 250;

export function summarizeNumbers(values) {
	if (values.length === 0) return { count: 0, min: 0, max: 0, mean: 0 };
	const total = values.reduce((sum, value) => sum + value, 0);
	return {
		count: values.length,
		min: Math.min(...values),
		max: Math.max(...values),
		mean: total / values.length,
	};
}

function positiveNumber(value, name) {
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive number`);
	return parsed;
}

function positiveInteger(value, name) {
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
	return parsed;
}

export function parseArgs(args) {
	const options = {
		durationMs: DEFAULT_DURATION_SECONDS * 1000,
		fleetSamples: DEFAULT_FLEET_SAMPLES,
		burstGapMs: DEFAULT_BURST_GAP_MS,
	};
	let target;
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--help" || arg === "-h") return { help: true };
		if (arg === "--duration") {
			options.durationMs = positiveNumber(args[++index], "--duration") * 1000;
			continue;
		}
		if (arg === "--fleet-samples") {
			options.fleetSamples = positiveInteger(args[++index], "--fleet-samples");
			continue;
		}
		if (arg === "--burst-gap-ms") {
			options.burstGapMs = positiveNumber(args[++index], "--burst-gap-ms");
			continue;
		}
		if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
		if (target) throw new Error("Provide exactly one dashboard URL");
		target = arg;
	}
	if (!target) throw new Error("A dashboard URL is required");
	let base;
	try {
		base = new URL(target);
	} catch {
		throw new Error("Dashboard URL must be an absolute http(s) URL");
	}
	if (base.protocol !== "http:" && base.protocol !== "https:") {
		throw new Error("Dashboard URL must use http or https");
	}
	return { ...options, base };
}

export function usage() {
	return `Usage: npm run profile:mobile -- <dashboard-url> [options]

Measure dashboard fleet HTTP and SSE transport without saving fleet or event payloads.

Options:
  --duration <seconds>    SSE capture duration (default: ${DEFAULT_DURATION_SECONDS})
  --fleet-samples <n>     Number of fleet requests (default: ${DEFAULT_FLEET_SAMPLES})
  --burst-gap-ms <ms>     Gap that starts a new SSE burst (default: ${DEFAULT_BURST_GAP_MS})
  -h, --help              Show this help

Run against the dashboard's loopback URL on its host, for example:
  npm run profile:mobile -- http://127.0.0.1:5343`;
}

function endpoint(base, path) {
	return new URL(path, base).toString();
}

function eventType(frame) {
	let namedType = "message";
	const data = [];
	for (const line of frame.replaceAll("\r", "").split("\n")) {
		if (line.startsWith("event:")) namedType = line.slice("event:".length).trim() || "message";
		if (line.startsWith("data:")) data.push(line.slice("data:".length).trimStart());
	}
	if (data.length === 0) return "comment";
	if (namedType !== "message") return namedType;
	try {
		const parsed = JSON.parse(data.join("\n"));
		const type = parsed?.event?.type;
		return typeof type === "string" && type.length > 0 ? type : "invalid_message";
	} catch {
		return "invalid_message";
	}
}

/** Aggregate frames while retaining only event-type and numeric summaries. */
export function createSseAggregator(burstGapMs = DEFAULT_BURST_GAP_MS) {
	let buffered = "";
	const decoder = new TextDecoder();
	let receivedBytes = 0;
	let lastFrameAt;
	let currentBurst;
	const byType = new Map();
	const burstEventCounts = [];
	const burstBytes = [];

	const finishBurst = () => {
		if (!currentBurst) return;
		burstEventCounts.push(currentBurst.events);
		burstBytes.push(currentBurst.bytes);
		currentBurst = undefined;
	};
	const record = (frame, separator, receivedAt) => {
		const bytes = Buffer.byteLength(frame + separator);
		const type = eventType(frame);
		const aggregate = byType.get(type) ?? { count: 0, encodedBytes: 0 };
		aggregate.count += 1;
		aggregate.encodedBytes += bytes;
		byType.set(type, aggregate);
		if (lastFrameAt === undefined || receivedAt - lastFrameAt > burstGapMs) {
			finishBurst();
			currentBurst = { events: 0, bytes: 0 };
		}
		currentBurst.events += 1;
		currentBurst.bytes += bytes;
		lastFrameAt = receivedAt;
	};
	const consume = (receivedAt) => {
		while (true) {
			const separator = buffered.match(/\r?\n\r?\n/);
			if (!separator || separator.index === undefined) return;
			const frame = buffered.slice(0, separator.index);
			buffered = buffered.slice(separator.index + separator[0].length);
			record(frame, separator[0], receivedAt);
		}
	};
	return {
		ingest(chunk, receivedAt) {
			receivedBytes += chunk.byteLength;
			buffered += decoder.decode(chunk, { stream: true });
			consume(receivedAt);
		},
		ingestText(text, receivedAt) {
			receivedBytes += Buffer.byteLength(text);
			buffered += text;
			consume(receivedAt);
		},
		summary() {
			finishBurst();
			const eventsByType = Object.fromEntries([...byType.entries()].sort(([left], [right]) => left.localeCompare(right)));
			const attributedBytes = [...byType.values()].reduce((total, aggregate) => total + aggregate.encodedBytes, 0);
			return {
				receivedBytes,
				unattributedBytes: Math.max(0, receivedBytes - attributedBytes),
				eventsByType,
				bursts: {
					count: burstEventCounts.length,
					eventCount: summarizeNumbers(burstEventCounts),
					encodedBytes: summarizeNumbers(burstBytes),
				},
			};
		},
	};
}

async function requireLocalDashboard(base) {
	let response;
	try {
		response = await fetch(endpoint(base, "/api/auth"));
	} catch (error) {
		throw new Error(`Could not reach dashboard auth endpoint: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!response.ok) {
		throw new Error(
			`Dashboard authentication failed (${response.status}). For local profiling, run this on the dashboard host with its loopback URL.`,
		);
	}
	let mode;
	try {
		mode = (await response.json()).mode;
	} catch {
		throw new Error("Dashboard auth endpoint returned invalid JSON");
	}
	if (mode === "local") return "local";
	throw new Error("Mobile profiling must run on the dashboard host against its loopback URL.");
}

async function measureFleet(base, samples) {
	const elapsedMs = [];
	const encodedBytes = [];
	for (let index = 0; index < samples; index += 1) {
		const startedAt = performance.now();
		let response;
		try {
			response = await fetch(endpoint(base, "/api/fleet"));
		} catch (error) {
			throw new Error(`Fleet request ${index + 1}/${samples} failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (!response.ok) throw new Error(`Fleet request ${index + 1}/${samples} returned HTTP ${response.status}`);
		const body = await response.arrayBuffer();
		elapsedMs.push(performance.now() - startedAt);
		encodedBytes.push(body.byteLength);
	}
	return { elapsedMs: summarizeNumbers(elapsedMs), encodedBytes: summarizeNumbers(encodedBytes) };
}

async function measureSse(base, durationMs, burstGapMs) {
	const controller = new AbortController();
	let response;
	try {
		response = await fetch(endpoint(base, "/api/events"), {
			headers: { accept: "text/event-stream" },
			signal: controller.signal,
		});
	} catch (error) {
		throw new Error(`Could not open SSE stream: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!response.ok || !response.body) throw new Error(`SSE stream returned HTTP ${response.status}`);
	const aggregate = createSseAggregator(burstGapMs);
	const startedAt = performance.now();
	const stop = setTimeout(() => controller.abort(), durationMs);
	try {
		const reader = response.body.getReader();
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				if (!controller.signal.aborted) throw new Error("SSE stream closed before the requested duration");
				break;
			}
			if (value) aggregate.ingest(value, performance.now() - startedAt);
		}
	} catch (error) {
		if (!controller.signal.aborted) throw new Error(`SSE capture failed: ${error instanceof Error ? error.message : String(error)}`);
	} finally {
		clearTimeout(stop);
	}
	return { durationMs, ...aggregate.summary() };
}

export async function profile(options) {
	const authMode = await requireLocalDashboard(options.base);
	const [fleet, sse] = await Promise.all([
		measureFleet(options.base, options.fleetSamples),
		measureSse(options.base, options.durationMs, options.burstGapMs),
	]);
	return { authMode, fleet, sse };
}

async function main() {
	try {
		const options = parseArgs(process.argv.slice(2));
		if (options.help) {
			console.log(usage());
			return;
		}
		console.log(JSON.stringify(await profile(options), null, 2));
	} catch (error) {
		console.error(`profile-mobile: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
