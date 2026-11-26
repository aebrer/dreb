import type { Router } from "express";
import express from "express";
import type { AutomationModel, AutomationSetupMessage } from "../shared/automation.js";
import type { AutomationRunner } from "./automation-runner.js";
import { resolveExistingDirectory } from "./files.js";
import type { RuntimePool } from "./runtime-pool.js";

function model(value: unknown): AutomationModel | undefined {
	if (!value || typeof value !== "object") return undefined;
	const { provider, id } = value as Partial<AutomationModel>;
	if (
		typeof provider !== "string" ||
		!provider ||
		provider.startsWith("-") ||
		typeof id !== "string" ||
		!id ||
		id.startsWith("-")
	) {
		return undefined;
	}
	return { provider, id };
}

function chat(value: unknown): value is AutomationSetupMessage[] {
	return (
		Array.isArray(value) &&
		value.length > 0 &&
		value.at(-1)?.role === "user" &&
		value.every(
			(item, i) =>
				item &&
				item.role === (i % 2 === 0 ? "user" : "assistant") &&
				typeof item.text === "string" &&
				item.text.trim(),
		)
	);
}

export function automationRoutes(
	runner: AutomationRunner,
	pool: RuntimePool,
	projectMessages: (id: string, messages: unknown[]) => unknown[],
): Router {
	const router = express.Router();
	router.get("/models", async (req, res) => {
		let cwd: string;
		try {
			cwd = await resolveExistingDirectory(typeof req.query.cwd === "string" ? req.query.cwd : "");
		} catch (error) {
			res.status(400).json({ error: String(error) });
			return;
		}
		try {
			const handle = await pool.ensureUtilityRuntime(cwd);
			res.json({ cwd, models: await handle.client.getAvailableModels() });
		} catch (error) {
			res.status(502).json({ error: String(error) });
		}
	});
	router.post("/setup", async (req, res) => {
		const selected = model(req.body?.model);
		const messages: unknown = req.body?.messages;
		if (!selected || !chat(messages)) {
			res.status(400).json({ error: "Choose a model and send a setup message." });
			return;
		}
		let cwd: string;
		try {
			cwd = await resolveExistingDirectory(typeof req.body?.cwd === "string" ? req.body.cwd : "");
		} catch (error) {
			res.status(400).json({ error: String(error) });
			return;
		}
		try {
			res.json(
				await runner.setup(
					cwd,
					selected,
					messages.map(({ role, text }) => ({ role, text })),
				),
			);
		} catch (error) {
			res.status(502).json({ error: String(error) });
		}
	});
	router.get("/runs", (_req, res) => res.json({ runs: runner.store.list() }));
	router.post("/runs", async (req, res) => {
		const workerModel = model(req.body?.workerModel);
		const guardModel = model(req.body?.guardModel);
		const instructions: unknown = req.body?.instructions;
		if (!workerModel || !guardModel || typeof instructions !== "string" || !instructions.trim()) {
			res.status(400).json({ error: "Both models and agreed instructions are required." });
			return;
		}
		let cwd: string;
		try {
			cwd = await resolveExistingDirectory(typeof req.body?.cwd === "string" ? req.body.cwd : "");
		} catch (error) {
			res.status(400).json({ error: String(error) });
			return;
		}
		try {
			res.status(201).json({ id: runner.launch({ cwd, workerModel, guardModel, instructions }) });
		} catch (error) {
			res.status(502).json({ error: String(error) });
		}
	});
	router.get("/runs/:id", (req, res) => {
		const detail = runner.detail(req.params.id);
		if (!detail) res.status(404).json({ error: "Automation run not found." });
		else res.json(detail);
	});
	router.get("/runs/:id/messages", (req, res) => {
		try {
			const messages = runner.transcript(req.params.id);
			if (!messages) res.status(404).json({ error: "No saved session for this run." });
			else res.json({ messages: projectMessages(req.params.id, messages) });
		} catch (error) {
			res.status(502).json({ error: String(error) });
		}
	});
	router.post("/runs/:id/stop", (req, res) => {
		try {
			if (!runner.stop(req.params.id)) res.status(409).json({ error: "Automation run is not active." });
			else res.json({ ok: true });
		} catch (error) {
			res.status(502).json({ error: String(error) });
		}
	});
	return router;
}
