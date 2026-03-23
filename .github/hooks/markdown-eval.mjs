#!/usr/bin/env node

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";

function parseArgs(argv) {
	let json = false;
	let recordOutcomes = false;
	let limit = null;

	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (!arg) continue;

		if (arg === "--help" || arg === "-h") {
			printHelp();
			process.exit(0);
		}

		if (arg === "--json") {
			json = true;
			continue;
		}

		if (arg === "--record-outcomes") {
			recordOutcomes = true;
			continue;
		}

		if (arg === "--limit") {
			const next = argv[i + 1];
			if (!next) {
				throw new Error("Missing value for --limit");
			}
			const parsed = Number.parseInt(next, 10);
			if (Number.isNaN(parsed) || parsed <= 0) {
				throw new Error("--limit must be a positive integer");
			}
			limit = parsed;
			i += 1;
			continue;
		}

		throw new Error(`Unknown argument: ${arg}`);
	}

	return { json, recordOutcomes, limit };
}

function printHelp() {
	console.log(`Markdown self-learning eval

Usage:
  node .github/hooks/markdown-eval.mjs [--json] [--record-outcomes] [--limit N]

Options:
  --json             Output structured JSON
  --record-outcomes  Append markdown-eval outcomes to record files
  --limit N          Evaluate only the most recent N records
`);
}

function repoRuntimeDir() {
	return join(process.cwd(), ".github", "hooks", ".runtime");
}

function recordsDir() {
	return join(repoRuntimeDir(), "records");
}

function latestEvalPath() {
	return join(repoRuntimeDir(), "latest-eval.md");
}

async function readOptionalDirectory(path) {
	try {
		return await readdir(path);
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
			return [];
		}
		throw error;
	}
}

function getSectionLines(description, heading) {
	if (!description) return [];

	const lines = description.split(/\r?\n/);
	const headingIndex = lines.findIndex((line) => line.trim() === heading);
	if (headingIndex === -1) return [];

	const collected = [];
	for (let i = headingIndex + 1; i < lines.length; i += 1) {
		const line = lines[i]?.trim() ?? "";
		if (!line) break;
		if (!line.startsWith("- ")) break;
		collected.push(line.slice(2));
	}
	return collected;
}

function isDurableFile(filePath) {
	return filePath === "AGENTS.md" || filePath.startsWith("docs/");
}

function computeScore(record) {
	const promptLines = getSectionLines(record.description, "## Prompt summary");
	const changedFiles = getSectionLines(record.description, "## Changed files");
	const toolLines = getSectionLines(record.description, "## Tool outcomes");
	const hasCopilotOutcome = (record.outcomes ?? []).some((outcome) => outcome.agent === "github-copilot");

	let groundedness = 0;
	if (changedFiles.length > 0 && changedFiles[0] !== "No changed files") groundedness += 2;
	if (record.evidence?.file) groundedness += 1;

	let reusability = 0;
	const durableChanges = changedFiles.filter((f) => f !== "No changed files" && isDurableFile(f));
	if (durableChanges.length > 0) reusability += 1;

	let specificity = 0;
	if (promptLines.length > 0 && promptLines[0] !== "No prompts captured") specificity += 1;
	if ((record.description?.length ?? 0) >= 350) specificity += 1;

	let validationSignal = 0;
	if (hasCopilotOutcome) validationSignal += 1;
	if (toolLines.length > 0 && toolLines[0] !== "No tool usage captured") validationSignal += 1;

	return {
		groundedness,
		reusability,
		specificity,
		validationSignal,
		total: groundedness + reusability + specificity + validationSignal,
		max: 8,
	};
}

function getRecommendation(score) {
	if (score.total >= 7) return "promote";
	if (score.total >= 4) return "review";
	return "discard";
}

function buildReasons(record, score, recommendation) {
	const reasons = [];
	const changedFiles = getSectionLines(record.description, "## Changed files");
	const promptLines = getSectionLines(record.description, "## Prompt summary");
	const toolLines = getSectionLines(record.description, "## Tool outcomes");

	if (changedFiles.length > 0 && changedFiles[0] !== "No changed files") {
		reasons.push(`grounded in ${changedFiles.length} changed file(s)`);
	}
	if (promptLines.length > 0 && promptLines[0] !== "No prompts captured") {
		reasons.push("includes prompt context");
	}
	if (toolLines.length > 0 && toolLines[0] !== "No tool usage captured") {
		reasons.push("includes tool execution evidence");
	}
	if (score.total < 3) {
		reasons.push("weak grounding or low reusability signal");
	}
	if (recommendation === "promote") {
		reasons.push("strong candidate to keep reflected in durable docs (AGENTS.md or docs/)");
	}
	return reasons;
}

function evaluateRecord(record) {
	const score = computeScore(record);
	const recommendation = getRecommendation(score);
	const reasons = buildReasons(record, score, recommendation);
	const alreadyEvaluated = (record.outcomes ?? []).some((outcome) => outcome.agent === "markdown-eval");
	const alreadyPromoted = (record.outcomes ?? []).some((outcome) => outcome.agent === "markdown-promote");

	return {
		id: record.id ?? record.recorded_at ?? "(missing-id)",
		name: record.name ?? "Untitled record",
		recordedAt: record.recorded_at ?? "(unknown)",
		recommendation,
		score,
		reasons,
		alreadyEvaluated,
		alreadyPromoted,
	};
}

async function buildPromotionPrompt(root, record) {
	const templatePath = join(root, ".github", "hooks", "prompts", "promote-learnings.md");
	if (!existsSync(templatePath)) {
		console.warn(`promote-learnings.md not found at ${templatePath} — skipping promotion`);
		return null;
	}

	const template = await readFile(templatePath, "utf-8");
	const changedFiles = getSectionLines(record.description, "## Changed files");
	const promptLines = getSectionLines(record.description, "## Prompt summary");
	const toolLines = getSectionLines(record.description, "## Tool outcomes");

	return template
		.replace("{{prompts}}", promptLines.join("; ") || "none")
		.replace("{{changedFiles}}", changedFiles.join(", ") || "none")
		.replace("{{toolOutcomes}}", toolLines.join("; ") || "none");
}

async function spawnPromotion(root, entry) {
	const prompt = await buildPromotionPrompt(root, entry.record);
	if (!prompt) return;
	const child = spawn(
		"copilot",
		["-p", prompt, "--yolo", "--silent"],
		{ cwd: root, detached: true, stdio: "ignore" },
	);
	child.unref();
}

function formatMarkdown(results) {
	if (results.length === 0) {
		return "# Markdown eval report\n\nNo records found.";
	}

	const lines = ["# Markdown eval report", ""];

	for (const result of results) {
		lines.push(
			`## ${result.name}`,
			"",
			`- ID: \`${result.id}\``,
			`- Recorded: ${result.recordedAt}`,
			`- Recommendation: **${result.recommendation}**`,
			`- Score: ${result.score.total}/${result.score.max} (groundedness ${result.score.groundedness}, reusability ${result.score.reusability}, specificity ${result.score.specificity}, validation ${result.score.validationSignal})`,
		);
		if (result.alreadyEvaluated) {
			lines.push("- Existing eval outcome: yes");
		}
		if (result.alreadyPromoted) {
			lines.push("- AGENTS promotion: yes");
		}
		lines.push(`- Reasons: ${result.reasons.join("; ")}`, "");
	}

	return lines.join("\n");
}

async function readRecords(limit) {
	const files = (await readOptionalDirectory(recordsDir()))
		.filter((file) => file.endsWith(".json"))
		.sort()
		.reverse()
		.slice(0, limit ?? Number.MAX_SAFE_INTEGER);

	return await Promise.all(
		files.map(async (file) => {
			const path = join(recordsDir(), file);
			const raw = await readFile(path, "utf-8");
			return { path, record: JSON.parse(raw) };
		}),
	);
}

async function appendEvalOutcome(entry, result) {
	if (result.alreadyEvaluated) {
		return false;
	}

	const status =
		result.recommendation === "promote"
			? "success"
			: result.recommendation === "review"
				? "partial"
				: "failure";

	const newOutcomes = [
		{
			status,
			agent: "markdown-eval",
			notes: `recommendation=${result.recommendation}; reasons=${result.reasons.join(", ")}`,
			test_results: `score=${result.score.total}/${result.score.max}`,
			recorded_at: new Date().toISOString(),
		},
	];

	if (result.recommendation === "promote" && !result.alreadyPromoted) {
		newOutcomes.push({
			status: "pending",
			agent: "markdown-promote",
			notes: "AGENTS.md update queued for LLM promotion",
			recorded_at: new Date().toISOString(),
		});
	}

	const updated = {
		...entry.record,
		outcomes: [...(entry.record.outcomes ?? []), ...newOutcomes],
	};

	await writeFile(entry.path, `${JSON.stringify(updated, null, 2)}\n`, "utf-8");
	return true;
}

async function writeLatestEvalReport(markdown) {
	await mkdir(repoRuntimeDir(), { recursive: true });
	await writeFile(latestEvalPath(), `${markdown}\n`, "utf-8");
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	const entries = await readRecords(options.limit);
	const results = entries.map((entry) => evaluateRecord(entry.record));
	let outcomesAppended = 0;
	let promotionsSpawned = 0;

	if (options.recordOutcomes) {
		for (let index = 0; index < entries.length; index += 1) {
			const appended = await appendEvalOutcome(entries[index], results[index]);
			if (appended) {
				outcomesAppended += 1;
				if (results[index].recommendation === "promote" && !results[index].alreadyPromoted) {
					await spawnPromotion(process.cwd(), entries[index]);
					promotionsSpawned += 1;
				}
			}
		}
	}

	const markdown = formatMarkdown(results);
	await writeLatestEvalReport(markdown);

	if (options.json) {
		console.log(
			JSON.stringify(
				{
					success: true,
					command: "markdown-eval",
					results,
					outcomesAppended,
				},
				null,
				2,
			),
		);
		return;
	}

	console.log(markdown);
	if (options.recordOutcomes) {
		console.log(`\nRecorded ${outcomesAppended} markdown-eval outcome(s).`);
		if (promotionsSpawned > 0) {
			console.log(`Spawned ${promotionsSpawned} AGENTS.md promotion(s).`);
		}
	}
}

try {
	await main();
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	console.error(`Error: ${message}`);
	process.exit(1);
}
