#!/usr/bin/env node

import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function readStdin() {
	const chunks = [];
	for await (const chunk of process.stdin) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	return Buffer.concat(chunks).toString("utf-8");
}

function runtimeDirFor(root) {
	return join(tmpdir(), "markdown-copilot-hooks", Buffer.from(root).toString("base64url"));
}

function repoRuntimeDirFor(root) {
	return join(root, ".github", "hooks", ".runtime");
}

function recordsDirFor(root) {
	return join(repoRuntimeDirFor(root), "records");
}

function statePathFor(root) {
	return join(runtimeDirFor(root), "current-session.json");
}

function evalScriptPathFor(root) {
	return join(root, ".github", "hooks", "markdown-eval.mjs");
}

function primeContextPathFor(root) {
	return join(repoRuntimeDirFor(root), "prime.txt");
}

function latestSessionPathFor(root) {
	return join(repoRuntimeDirFor(root), "last-session.md");
}

function latestEvalPathFor(root) {
	return join(repoRuntimeDirFor(root), "latest-eval.md");
}

function excerpt(value, max = 160) {
	if (!value) return undefined;
	const compact = value.replace(/\s+/g, " ").trim();
	if (compact.length <= max) return compact;
	return `${compact.slice(0, max - 3)}...`;
}

function mapReasonToOutcome(reason) {
	switch (reason) {
		case "complete":
			return "success";
		case "error":
		case "timeout":
			return "failure";
		default:
			return "partial";
	}
}

async function readOptionalFile(path) {
	try {
		return await readFile(path, "utf-8");
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
			return "";
		}
		throw error;
	}
}

async function readSessionState(path) {
	try {
		const raw = await readFile(path, "utf-8");
		return JSON.parse(raw);
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
			return null;
		}
		throw error;
	}
}

async function writeSessionState(path, state) {
	if (state === null) {
		if (existsSync(path)) {
			await rm(path, { force: true });
		}
		return;
	}
	await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
}

function createSessionState(root, payload) {
	const sessionId = String(payload.timestamp ?? Date.now());
	const runtimeDir = runtimeDirFor(root);
	return {
		sessionId,
		startedAt: new Date(payload.timestamp ?? Date.now()).toISOString(),
		logPath: join(runtimeDir, `session-${sessionId}.jsonl`),
		recordPath: join(recordsDirFor(root), `${sessionId}.json`),
		primePath: primeContextPathFor(root),
	};
}

async function ensureSessionState(root, payload) {
	const runtimeDir = runtimeDirFor(root);
	const repoRuntimeDir = repoRuntimeDirFor(root);
	const statePath = statePathFor(root);
	await mkdir(runtimeDir, { recursive: true });
	await mkdir(repoRuntimeDir, { recursive: true });
	await mkdir(recordsDirFor(root), { recursive: true });

	const existing = await readSessionState(statePath);
	if (existing) {
		return existing;
	}

	const state = createSessionState(root, payload);
	await writeSessionState(statePath, state);
	return state;
}

async function appendEvent(logPath, event, details) {
	const entry = {
		event,
		recordedAt: new Date().toISOString(),
		details,
	};
	await appendFile(logPath, `${JSON.stringify(entry)}\n`, "utf-8");
}

async function readEvents(logPath) {
	try {
		const raw = await readFile(logPath, "utf-8");
		return raw
			.split(/\r?\n/)
			.filter(Boolean)
			.map((line) => JSON.parse(line));
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
			return [];
		}
		throw error;
	}
}

async function runCommand(command, cwd, input) {
	return await new Promise((resolve) => {
		const child = spawn(command[0], command.slice(1), { cwd, stdio: "pipe" });
		let stdout = "";
		let stderr = "";

		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});

		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});

		child.on("error", (error) => {
			const message = error instanceof Error ? error.message : String(error);
			resolve({
				ok: false,
				stdout,
				stderr: stderr ? `${stderr}\n${message}` : message,
				code: null,
			});
		});

		child.on("close", (code) => {
			resolve({
				ok: code === 0,
				stdout,
				stderr,
				code,
			});
		});

		if (input) {
			child.stdin.write(input);
		}
		child.stdin.end();
	});
}

async function runGit(root, args) {
	return await runCommand(["git", ...args], root);
}

function spawnBackgroundEval(root) {
	const evalScriptPath = evalScriptPathFor(root);
	if (!existsSync(evalScriptPath)) {
		return;
	}

	const child = spawn(process.execPath, [evalScriptPath, "--record-outcomes"], {
		cwd: root,
		detached: true,
		stdio: "ignore",
	});
	child.unref();
}

async function getChangedFiles(root, baseline) {
	const statusResult = await runGit(root, ["status", "--short", "--untracked-files=all"]);
	if (!statusResult.ok) {
		return [];
	}

	const baselineSet = new Set(baseline ?? []);
	const changed = new Set();
	for (const line of statusResult.stdout.split(/\r?\n/)) {
		if (!line.trim()) continue;
		const candidate = line.slice(3).trim();
		if (!candidate) continue;
		const filePath = candidate.includes(" -> ") ? candidate.split(" -> ").at(-1) : candidate;
		if (filePath && !baselineSet.has(filePath)) {
			changed.add(filePath);
		}
	}
	return [...changed];
}

function summarizeTools(events) {
	const summary = new Map();

	for (const event of events) {
		if (event.event !== "postToolUse") continue;

		const toolName = typeof event.details.toolName === "string" ? event.details.toolName : "unknown";
		const resultType =
			typeof event.details.resultType === "string" ? event.details.resultType : "success";

		if (!summary.has(toolName)) {
			summary.set(toolName, { success: 0, failure: 0, denied: 0 });
		}

		const counts = summary.get(toolName);
		if (!counts) continue;

		if (resultType === "failure") {
			counts.failure += 1;
		} else if (resultType === "denied") {
			counts.denied += 1;
		} else {
			counts.success += 1;
		}
	}

	return [...summary.entries()].map(([toolName, counts]) => {
		const parts = [];
		if (counts.success > 0) parts.push(`${counts.success} success`);
		if (counts.failure > 0) parts.push(`${counts.failure} failure`);
		if (counts.denied > 0) parts.push(`${counts.denied} denied`);
		return `- ${toolName}: ${parts.join(", ") || "no activity"}`;
	});
}

function summarizeFailures(events) {
	const failures = [];

	for (const event of events) {
		if (event.event === "postToolUse" && event.details.resultType === "failure") {
			const toolName = typeof event.details.toolName === "string" ? event.details.toolName : "unknown";
			const text =
				typeof event.details.textResult === "string" ? event.details.textResult : "tool execution failed";
			failures.push(`- ${toolName}: ${text}`);
		}

		if (event.event === "errorOccurred") {
			const name = typeof event.details.name === "string" ? event.details.name : "Error";
			const message =
				typeof event.details.message === "string" ? event.details.message : "unexpected agent error";
			failures.push(`- ${name}: ${message}`);
		}
	}

	return failures.slice(0, 5);
}

async function refreshPrimeFile(root, state) {
	const latestEval = await readOptionalFile(latestEvalPathFor(root));
	const latestSession = await readOptionalFile(latestSessionPathFor(root));

	// prime.txt contains only session-specific additions.
	// AGENTS.md is already read by Copilot directly — embedding it here would duplicate it.
	const primeSections = [
		"# Hook-generated session context",
		"",
		"This file supplements AGENTS.md with recent session history.",
		"It is regenerated each session. AGENTS.md is the durable source of truth.",
	];

	if (latestEval.trim()) {
		primeSections.push("", "## Latest evaluation summary", latestEval.trim());
	}

	if (latestSession.trim()) {
		primeSections.push("", "## Latest session handoff", latestSession.trim());
	}

	if (!latestEval.trim() && !latestSession.trim()) {
		primeSections.push("", "_No previous session history yet._");
	}

	await writeFile(state.primePath, `${primeSections.join("\n")}\n`, "utf-8");
}

function buildSessionMarkdown(state, promptSummary, changedFiles, toolSummary, failureSummary, agentsUpdated, reason) {
	const lines = [
		"# Markdown self-learning session",
		"",
		`- Session: ${state.sessionId}`,
		`- Started: ${state.startedAt}`,
		`- End reason: ${reason ?? "unknown"}`,
		`- AGENTS updated: ${agentsUpdated ? "yes" : "no"}`,
		"",
		"## Prompt summary",
		...(promptSummary.length > 0 ? promptSummary.map((prompt) => `- ${prompt}`) : ["- No prompts captured"]),
		"",
		"## Changed files",
		...(changedFiles.length > 0 ? changedFiles.map((file) => `- ${file}`) : ["- No changed files"]),
		"",
		"## Tool outcomes",
		...(toolSummary.length > 0 ? toolSummary : ["- No tool usage captured"]),
	];

	if (failureSummary.length > 0) {
		lines.push("", "## Failures observed", ...failureSummary);
	}

	return lines.join("\n");
}

async function handleSessionStart(root, payload) {
	const state = await ensureSessionState(root, payload);

	// Snapshot already-changed files so they can be excluded from the session's changed-files report.
	const baselineFiles = await getChangedFiles(root);
	state.baselineFiles = baselineFiles;
	await writeSessionState(statePathFor(root), state);

	await appendEvent(state.logPath, "sessionStart", {
		source: payload.source ?? "unknown",
		initialPrompt: excerpt(payload.initialPrompt, 240),
	});

	await refreshPrimeFile(root, state);

	await appendEvent(state.logPath, "primeExported", {
		primePath: state.primePath,
	});
}

async function handlePrompt(root, payload) {
	const state = await ensureSessionState(root, payload);
	await appendEvent(state.logPath, "userPromptSubmitted", {
		prompt: excerpt(payload.prompt, 400),
	});
}

async function handleTool(root, payload) {
	const state = await ensureSessionState(root, payload);
	await appendEvent(state.logPath, "postToolUse", {
		toolName: payload.toolName ?? "unknown",
		resultType: payload.toolResult?.resultType ?? "success",
		toolArgs: excerpt(payload.toolArgs, 240),
		textResult: excerpt(payload.toolResult?.textResultForLlm, 240),
	});
}

async function handleError(root, payload) {
	const state = await ensureSessionState(root, payload);
	await appendEvent(state.logPath, "errorOccurred", {
		name: payload.error?.name ?? "Error",
		message: excerpt(payload.error?.message, 240),
	});
}

async function handleSessionEnd(root, payload) {
	const state = await ensureSessionState(root, payload);
	await appendEvent(state.logPath, "sessionEnd", {
		reason: payload.reason ?? "unknown",
	});

	const events = await readEvents(state.logPath);
	const promptSummary = events
		.filter((event) => event.event === "userPromptSubmitted")
		.map((event) => (typeof event.details.prompt === "string" ? event.details.prompt : undefined))
		.filter(Boolean);
	const changedFiles = await getChangedFiles(root, state.baselineFiles ?? []);
	const toolSummary = summarizeTools(events);
	const failureSummary = summarizeFailures(events);
	const agentsUpdated = changedFiles.includes("AGENTS.md");

	if (changedFiles.length === 0 && promptSummary.length === 0 && failureSummary.length === 0) {
		await writeSessionState(statePathFor(root), null);
		return;
	}

	const description = buildSessionMarkdown(
		state,
		promptSummary,
		changedFiles,
		toolSummary,
		failureSummary,
		agentsUpdated,
		payload.reason,
	);

	const record = {
		type: "reference",
		name: `Copilot session ${state.startedAt}`,
		description,
		classification: "tactical",
		recorded_at: new Date().toISOString(),
		files: changedFiles.slice(0, 25),
		tags: ["copilot", "hooks", "self-learning", "markdown", "session"],
		evidence: {
			date: state.startedAt,
			...(changedFiles[0] ? { file: changedFiles[0] } : {}),
		},
		metadata: {
			agentsUpdated,
			promptCount: promptSummary.length,
			toolCount: toolSummary.length,
		},
		outcomes: [
			{
				status: mapReasonToOutcome(payload.reason),
				agent: "github-copilot",
				notes: excerpt(promptSummary[0] ?? "Markdown session summary", 240),
				test_results: `reason=${payload.reason ?? "unknown"}; agentsUpdated=${agentsUpdated}`,
				recorded_at: new Date().toISOString(),
			},
		],
	};

	await writeFile(state.recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf-8");
	await writeFile(latestSessionPathFor(root), `${description}\n`, "utf-8");
	await refreshPrimeFile(root, state);
	await writeSessionState(statePathFor(root), null);
	spawnBackgroundEval(root);
}

const eventName = process.argv[2];
if (!eventName) {
	process.exit(0);
}

const rawInput = await readStdin();
const payload = rawInput.trim() ? JSON.parse(rawInput) : {};
const root = typeof payload.cwd === "string" ? payload.cwd : process.cwd();

switch (eventName) {
	case "sessionStart":
		await handleSessionStart(root, payload);
		break;
	case "userPromptSubmitted":
		await handlePrompt(root, payload);
		break;
	case "postToolUse":
		await handleTool(root, payload);
		break;
	case "errorOccurred":
		await handleError(root, payload);
		break;
	case "sessionEnd":
		await handleSessionEnd(root, payload);
		break;
	default:
		break;
}
