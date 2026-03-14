#!/usr/bin/env node

import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const COPILOT_DOMAIN = "copilot";

async function readStdin() {
	const chunks = [];
	for await (const chunk of process.stdin) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	return Buffer.concat(chunks).toString("utf-8");
}

function runtimeDirFor(root) {
	return join(tmpdir(), "mulch-copilot-hooks", Buffer.from(root).toString("base64url"));
}

function repoRuntimeDirFor(root) {
	return join(root, ".github", "hooks", ".runtime");
}

function excerpt(value, max = 160) {
	if (!value) return undefined;
	const compact = value.replace(/\s+/g, " ").trim();
	if (compact.length <= max) return compact;
	return `${compact.slice(0, max - 3)}...`;
}

function statePathFor(root) {
	return join(runtimeDirFor(root), "current-session.json");
}

function evalScriptPathFor(root) {
	return join(root, ".github", "hooks", "mulch-eval.mjs");
}

function primeContextPathFor(root) {
	return join(repoRuntimeDirFor(root), "prime.txt");
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

async function readSessionState(path) {
	try {
		const raw = await readFile(path, "utf-8");
		return JSON.parse(raw);
	} catch {
		return null;
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
		primePath: primeContextPathFor(root),
	};
}

async function ensureSessionState(root, payload) {
	const runtimeDir = runtimeDirFor(root);
	const repoRuntimeDir = repoRuntimeDirFor(root);
	const statePath = statePathFor(root);
	await mkdir(runtimeDir, { recursive: true });
	await mkdir(repoRuntimeDir, { recursive: true });

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
				notFound: error?.code === "ENOENT",
			});
		});

		child.on("close", (code) => {
			resolve({
				ok: code === 0,
				stdout,
				stderr,
				code,
				notFound: false,
			});
		});

		if (input) {
			child.stdin.write(input);
		}
		child.stdin.end();
	});
}

async function runMulch(root, args, input) {
	const candidates = [
		["./node_modules/.bin/ml"],
		["./node_modules/.bin/mulch"],
		["npx", "--no-install", "ml"],
		["npx", "--no-install", "mulch"],
		["ml"],
		["mulch"],
	];

	let lastResult = {
		ok: false,
		stdout: "",
		stderr: "Unable to find the Mulch CLI. Install it in the target repository first.",
		code: null,
		notFound: true,
	};

	for (const candidate of candidates) {
		const result = await runCommand([...candidate, ...args], root, input);
		if (result.notFound) {
			lastResult = result;
			continue;
		}
		return result;
	}

	return lastResult;
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

async function readEvents(logPath) {
	try {
		const raw = await readFile(logPath, "utf-8");
		return raw
			.split(/\r?\n/)
			.filter(Boolean)
			.map((line) => JSON.parse(line));
	} catch {
		return [];
	}
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

async function handleSessionStart(root, payload) {
	const state = await ensureSessionState(root, payload);
	await appendEvent(state.logPath, "sessionStart", {
		source: payload.source ?? "unknown",
		initialPrompt: excerpt(payload.initialPrompt, 240),
	});

	const primeResult = await runMulch(root, [
		"prime",
		"--exclude-domain",
		COPILOT_DOMAIN,
		"--format",
		"plain",
		"--export",
		state.primePath,
	]);

	await appendEvent(state.logPath, primeResult.ok ? "primeExported" : "primeExportFailed", {
		stdout: excerpt(primeResult.stdout, 240),
		stderr: excerpt(primeResult.stderr, 240),
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

	const learnResult = await runMulch(root, ["learn", "--json"]);
	let learnData = {};
	if (learnResult.ok) {
		try {
			learnData = JSON.parse(learnResult.stdout);
		} catch {
			learnData = {};
		}
	}

	const changedFiles = Array.isArray(learnData.changedFiles) ? learnData.changedFiles : [];
	const suggestedDomains = Array.isArray(learnData.suggestedDomains) ? learnData.suggestedDomains : [];
	const toolSummary = summarizeTools(events);
	const failureSummary = summarizeFailures(events);

	if (changedFiles.length === 0 && promptSummary.length === 0 && failureSummary.length === 0) {
		await writeSessionState(statePathFor(root), null);
		return;
	}

	const descriptionLines = [
		"GitHub Copilot hook summary for a completed session.",
		"",
		"Prompt summary:",
		...(promptSummary.length > 0 ? promptSummary.map((prompt) => `- ${prompt}`) : ["- No prompts captured"]),
		"",
		"Suggested domains:",
		...(suggestedDomains.length > 0
			? suggestedDomains.map((entry) => {
					const domain = typeof entry.domain === "string" ? entry.domain : "unknown";
					const matchCount = typeof entry.matchCount === "number" ? entry.matchCount : 0;
					return `- ${domain} (${matchCount} file matches)`;
				})
			: ["- No domain suggestions"]),
		"",
		"Changed files:",
		...(changedFiles.length > 0 ? changedFiles.map((file) => `- ${file}`) : ["- No changed files"]),
		"",
		"Tool outcomes:",
		...(toolSummary.length > 0 ? toolSummary : ["- No tool usage captured"]),
	];

	if (failureSummary.length > 0) {
		descriptionLines.push("", "Failures observed:", ...failureSummary);
	}

	if (!learnResult.ok && learnResult.stderr) {
		descriptionLines.push("", "Learn command note:", `- ${excerpt(learnResult.stderr, 240)}`);
	}

	const record = {
		type: "reference",
		name: `Copilot session ${state.startedAt}`,
		description: descriptionLines.join("\n"),
		classification: "tactical",
		recorded_at: new Date().toISOString(),
		files: changedFiles.slice(0, 25),
		tags: ["copilot", "hooks", "self-learning", "session"],
		evidence: {
			date: state.startedAt,
			...(changedFiles[0] ? { file: changedFiles[0] } : {}),
		},
		outcomes: [
			{
				status: mapReasonToOutcome(payload.reason),
				agent: "github-copilot",
				notes: excerpt(promptSummary[0] ?? "Copilot session summary", 240),
				test_results: `reason=${payload.reason ?? "unknown"}; suggestedDomains=${
					suggestedDomains
						.map((entry) => (typeof entry.domain === "string" ? entry.domain : "unknown"))
						.join(",") || "none"
				}`,
				recorded_at: new Date().toISOString(),
			},
		],
	};

	await runMulch(root, ["record", COPILOT_DOMAIN, "--stdin"], JSON.stringify(record));
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
