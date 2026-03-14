#!/usr/bin/env node

import { spawn } from "node:child_process";

function parseArgs(argv) {
	let json = false;
	let recordOutcomes = false;
	let limit = null;
	let domain = "copilot";

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

		if (arg === "--domain") {
			const next = argv[i + 1];
			if (!next) {
				throw new Error("Missing value for --domain");
			}
			domain = next;
			i += 1;
			continue;
		}

		throw new Error(`Unknown argument: ${arg}`);
	}

	return { json, recordOutcomes, limit, domain };
}

function printHelp() {
	console.log(`Mulch Copilot eval

Usage:
  node .github/hooks/mulch-eval.mjs [--json] [--record-outcomes] [--limit N] [--domain copilot]

Options:
  --json             Output structured JSON
  --record-outcomes  Append mulch-eval outcomes to evaluated records
  --limit N          Evaluate only the most recent N records
  --domain NAME      Evaluate a Mulch domain (default: copilot)
`);
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

async function runMulch(args, input) {
	const cwd = process.cwd();
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
		const result = await runCommand([...candidate, ...args], cwd, input);
		if (result.notFound) {
			lastResult = result;
			continue;
		}
		return result;
	}

	return lastResult;
}

function getSectionLines(description, heading) {
	if (!description) return [];

	const lines = description.split(/\r?\n/);
	const headingIndex = lines.findIndex((line) => line.trim() === `${heading}:`);
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

function parseSuggestedDomains(record) {
	const fromDescription = getSectionLines(record.description, "Suggested domains")
		.map((line) => line.match(/^([^()]+)/)?.[1]?.trim() ?? "")
		.filter(Boolean)
		.filter((line) => line !== "No domain suggestions");

	if (fromDescription.length > 0) {
		return [...new Set(fromDescription)];
	}

	const summary = record.outcomes?.[0]?.test_results;
	if (!summary) return [];

	const match = summary.match(/suggestedDomains=([^;]+)/);
	if (!match?.[1]) return [];

	return match[1]
		.split(",")
		.map((value) => value.trim())
		.filter((value) => value.length > 0 && value !== "none");
}

function computeScore(record) {
	const promptLines = getSectionLines(record.description, "Prompt summary");
	const suggestedDomains = parseSuggestedDomains(record);
	const toolLines = getSectionLines(record.description, "Tool outcomes");
	const hasGithubCopilotOutcome = (record.outcomes ?? []).some((outcome) => outcome.agent === "github-copilot");

	let groundedness = 0;
	if ((record.files?.length ?? 0) > 0) groundedness += 2;
	if (record.evidence?.file) groundedness += 1;

	let reusability = 0;
	if (suggestedDomains.length > 0) reusability += 2;
	if ((record.files?.length ?? 0) >= 2) reusability += 1;

	let specificity = 0;
	if (promptLines.length > 0 && promptLines[0] !== "No prompts captured") specificity += 1;
	if ((record.description?.length ?? 0) >= 400) specificity += 1;

	let validationSignal = 0;
	if (hasGithubCopilotOutcome) validationSignal += 1;
	if (toolLines.length > 0 && toolLines[0] !== "No tool usage captured") validationSignal += 1;

	return {
		groundedness,
		reusability,
		specificity,
		validationSignal,
		total: groundedness + reusability + specificity + validationSignal,
		max: 10,
	};
}

function getRecommendation(score) {
	if (score.total >= 8) return "promote";
	if (score.total >= 5) return "review";
	return "discard";
}

function buildReasons(record, score, recommendation) {
	const reasons = [];
	const suggestedDomains = parseSuggestedDomains(record);
	const promptLines = getSectionLines(record.description, "Prompt summary");
	const toolLines = getSectionLines(record.description, "Tool outcomes");

	if ((record.files?.length ?? 0) > 0) {
		reasons.push(`grounded in ${record.files?.length} changed file(s)`);
	}
	if (suggestedDomains.length > 0) {
		reasons.push(`maps to ${suggestedDomains.join(", ")}`);
	}
	if (promptLines.length > 0 && promptLines[0] !== "No prompts captured") {
		reasons.push("includes prompt context");
	}
	if (toolLines.length > 0 && toolLines[0] !== "No tool usage captured") {
		reasons.push("includes tool execution evidence");
	}
	if (score.total < 4) {
		reasons.push("weak grounding or low reusability signal");
	}
	if (recommendation === "promote") {
		reasons.push("strong candidate to mine into real domains");
	}
	return reasons;
}

function evaluateRecord(record) {
	const score = computeScore(record);
	const recommendation = getRecommendation(score);
	const reasons = buildReasons(record, score, recommendation);
	const alreadyEvaluated = (record.outcomes ?? []).some((outcome) => outcome.agent === "mulch-eval");

	return {
		id: record.id ?? "(missing-id)",
		name: record.name ?? "Untitled record",
		recordedAt: record.recorded_at ?? "(unknown)",
		recommendation,
		suggestedDomains: parseSuggestedDomains(record),
		score,
		reasons,
		alreadyEvaluated,
	};
}

function formatMarkdown(results, domain) {
	if (results.length === 0) {
		return `# Mulch eval report\n\nNo records found in \`${domain}\`.`;
	}

	const lines = ["# Mulch eval report", "", `Domain: \`${domain}\``, ""];

	for (const result of results) {
		lines.push(
			`## ${result.name}`,
			"",
			`- ID: \`${result.id}\``,
			`- Recorded: ${result.recordedAt}`,
			`- Recommendation: **${result.recommendation}**`,
			`- Score: ${result.score.total}/${result.score.max} (groundedness ${result.score.groundedness}, reusability ${result.score.reusability}, specificity ${result.score.specificity}, validation ${result.score.validationSignal})`,
		);
		if (result.suggestedDomains.length > 0) {
			lines.push(`- Suggested domains: ${result.suggestedDomains.join(", ")}`);
		}
		if (result.alreadyEvaluated) {
			lines.push("- Existing eval outcome: yes");
		}
		lines.push(`- Reasons: ${result.reasons.join("; ")}`, "");
	}

	return lines.join("\n");
}

async function appendEvalOutcome(domain, result) {
	if (result.alreadyEvaluated) {
		return null;
	}

	const status =
		result.recommendation === "promote"
			? "success"
			: result.recommendation === "review"
				? "partial"
				: "failure";

	return await runMulch([
		"outcome",
		domain,
		result.id,
		"--status",
		status,
		"--agent",
		"mulch-eval",
		"--notes",
		`recommendation=${result.recommendation}; reasons=${result.reasons.join(", ")}`,
		"--test-results",
		`score=${result.score.total}/${result.score.max}; suggestedDomains=${result.suggestedDomains.join(",") || "none"}`,
	]);
}

async function main() {
	const options = parseArgs(process.argv.slice(2));

	const queryResult = await runMulch(["query", options.domain, "--json"]);
	if (!queryResult.ok) {
		throw new Error(queryResult.stderr || "Failed to query Mulch records.");
	}

	const parsed = JSON.parse(queryResult.stdout);
	if (!parsed.success) {
		throw new Error(parsed.error || "Mulch query returned an unsuccessful response.");
	}

	const domainResult = parsed.domains?.find((entry) => entry.domain === options.domain);
	const records = [...(domainResult?.records ?? [])]
		.sort((a, b) => (b.recorded_at ?? "").localeCompare(a.recorded_at ?? ""))
		.slice(0, options.limit ?? Number.MAX_SAFE_INTEGER);

	const results = records.map(evaluateRecord);
	const outcomeResults = options.recordOutcomes
		? await Promise.all(
				results.map(async (result) => ({ result, outcome: await appendEvalOutcome(options.domain, result) })),
			)
		: [];

	if (options.json) {
		console.log(
			JSON.stringify(
				{
					success: true,
					command: "mulch-eval",
					domain: options.domain,
					results,
					outcomesAppended: outcomeResults.filter((entry) => entry.outcome?.ok).length,
				},
				null,
				2,
			),
		);
		return;
	}

	console.log(formatMarkdown(results, options.domain));
	if (options.recordOutcomes) {
		const appended = outcomeResults.filter((entry) => entry.outcome?.ok).length;
		console.log(`\nRecorded ${appended} mulch-eval outcome(s).`);
	}
}

try {
	await main();
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	console.error(`Error: ${message}`);
	process.exit(1);
}
