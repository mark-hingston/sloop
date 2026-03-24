#!/usr/bin/env node

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { execSync, spawn } from "node:child_process";
import { join } from "node:path";

function parseArgs(argv) {
	let json = false;
	let recordOutcomes = false;
	let semantic = false;
	let synthesise = false;
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

		if (arg === "--semantic") {
			semantic = true;
			continue;
		}

		if (arg === "--synthesise") {
			synthesise = true;
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

	return { json, recordOutcomes, semantic, synthesise, limit };
}

function printHelp() {
	console.log(`Markdown self-learning eval

Usage:
  node .github/hooks/markdown-eval.mjs [--json] [--record-outcomes] [--semantic] [--synthesise] [--limit N]

Options:
  --json             Output structured JSON
  --record-outcomes  Append markdown-eval outcomes to record files
  --semantic         Enrich records with LLM-based semantic quality score (requires gh auth)
  --synthesise       Batch synthesise review-tier sessions into durable docs (min ${SYNTHESISE_MIN_RECORDS})
                     Near-duplicate sessions are deduplicated via Jaccard similarity (threshold 0.7) before batching.
  --limit N          Evaluate only the most recent N records

Scoring:
  groundedness (0–3), reusability (0–2), specificity (0–2), validation (0–2), semantic (0–2), max 11
  Classifier penalty: -1 applied when >75% of prompt lines are questions or meta-talk (classifierPenalty in JSON output).
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

function buildSemanticScoringPrompt(record) {
	return `You are evaluating a Copilot agent session record to decide if its learnings are worth promoting to durable project documentation (AGENTS.md or docs/).

Score the session on two dimensions, each 0 or 1:

**actionability** (0 or 1)
- 1 if the session contains specific, codebase-relevant guidance that would change how a future agent approaches similar work
- 0 if it is generic, trivial, or contains no reusable insight

**gap_detection** (0 or 1)
- 1 if the session surfaces a pattern, failure, or convention that is likely missing from or underspecified in existing project docs
- 0 if the learnings are already well-covered or too narrow to generalise

Return ONLY valid JSON in this exact shape — no markdown, no explanation:
{"actionability": 0_or_1, "gap_detection": 0_or_1, "reason": "one sentence"}

Session record:
${record.description ?? "(no description)"}`;
}

async function fetchSemanticScore(record, root) {
	// Skip if already scored this session
	if (record.metadata?.semanticScore) {
		return null;
	}

	let token;
	try {
		token = execSync("gh auth token", { cwd: root, encoding: "utf-8" }).trim();
	} catch {
		return null;
	}

	if (!token) return null;

	try {
		const response = await fetch("https://models.inference.ai.azure.com/chat/completions", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: "openai/gpt-4o-mini",
				messages: [{ role: "user", content: buildSemanticScoringPrompt(record) }],
				response_format: { type: "json_object" },
				max_tokens: 120,
				temperature: 0,
			}),
		});

		if (!response.ok) return null;

		const data = await response.json();
		const raw = data.choices?.[0]?.message?.content;
		if (!raw) return null;

		const parsed = JSON.parse(raw);
		const actionability = parsed.actionability === 1 ? 1 : 0;
		const gapDetection = parsed.gap_detection === 1 ? 1 : 0;

		return {
			score: actionability + gapDetection,
			actionability,
			gapDetection,
			reason: typeof parsed.reason === "string" ? parsed.reason : "",
			scoredAt: new Date().toISOString(),
		};
	} catch {
		return null;
	}
}


function classifyPromptQuality(promptLines) {
	if (promptLines.length === 0) return { penalty: 0 };

	const META_PATTERNS = [
		/^\s*let me\b/i,
		/^\s*i think\b/i,
		/^\s*maybe\b/i,
		/^\s*can you\b/i,
		/^\s*could you\b/i,
		/^\s*what (is|are|do|does|should)\b/i,
		/^\s*how (do|does|can|should)\b/i,
		/^\s*is there\b/i,
		/^\s*are there\b/i,
		/\?$/, // ends with question mark
	];

	const metaCount = promptLines.filter((line) =>
		META_PATTERNS.some((p) => p.test(line)),
	).length;

	const metaRatio = metaCount / promptLines.length;
	// Apply penalty of 1 if >75% of prompts look like questions/meta-talk
	return { penalty: metaRatio >= 0.75 ? 1 : 0, metaRatio: Math.round(metaRatio * 100) };
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
	if (durableChanges.includes("AGENTS.md") || durableChanges.length >= 2) reusability += 1;

	let specificity = 0;
	if (promptLines.length > 0 && promptLines[0] !== "No prompts captured") specificity += 1;
	if ((record.description?.length ?? 0) >= 350) specificity += 1;

	let validationSignal = 0;
	if (hasCopilotOutcome) validationSignal += 1;
	if (toolLines.length > 0 && toolLines[0] !== "No tool usage captured") validationSignal += 1;

	const semanticQuality = record.metadata?.semanticScore?.score ?? 0;

	const promptQuality = classifyPromptQuality(promptLines);
	const classifierPenalty = promptQuality.penalty;

	return {
		groundedness,
		reusability,
		specificity,
		validationSignal,
		semanticQuality,
		classifierPenalty,
		total: Math.max(0, groundedness + reusability + specificity + validationSignal + semanticQuality - classifierPenalty),
		max: 11,
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

	const knowledgeTypes = Array.isArray(record.metadata?.knowledgeTypes)
		? record.metadata.knowledgeTypes.join(", ")
		: "general";

	return template
		.replace("{{prompts}}", promptLines.join("; ") || "none")
		.replace("{{changedFiles}}", changedFiles.join(", ") || "none")
		.replace("{{toolOutcomes}}", toolLines.join("; ") || "none")
		.replace("{{knowledgeTypes}}", knowledgeTypes);
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

const SYNTHESISE_MIN_RECORDS = 3;

function collectReviewCandidates(entries, results) {
	return entries.filter((entry, index) => {
		if (results[index].recommendation !== "review") return false;
		const alreadySynthesised = (entry.record.outcomes ?? []).some(
			(o) => o.agent === "markdown-synthesise",
		);
		return !alreadySynthesised;
	});
}

function tokenize(text) {
	if (!text) return new Set();
	return new Set(
		text
			.toLowerCase()
			.replace(/[^\w\s]/g, " ")
			.split(/\s+/)
			.filter((t) => t.length > 3),
	);
}

function jaccardSimilarity(setA, setB) {
	if (setA.size === 0 && setB.size === 0) return 1;
	const intersection = new Set([...setA].filter((x) => setB.has(x)));
	const union = new Set([...setA, ...setB]);
	return union.size === 0 ? 0 : intersection.size / union.size;
}

function deduplicateByJaccard(reviewEntries, results, threshold = 0.7) {
	// Build token sets from description + prompts for each entry
	const tokenSets = reviewEntries.map((entry) => {
		const promptLines = getSectionLines(entry.record.description, "## Prompt summary");
		const text = [entry.record.description ?? "", ...promptLines].join(" ");
		return tokenize(text);
	});

	// Find the eval score for each entry (from outcomes or results array)
	const scores = reviewEntries.map((entry, i) => {
		const evalOutcome = (entry.record.outcomes ?? []).find((o) => o.agent === "markdown-eval");
		if (evalOutcome) {
			const match = evalOutcome.test_results?.match(/score=(\d+)/);
			return match ? Number.parseInt(match[1], 10) : 0;
		}
		return results[i]?.score?.total ?? 0;
	});

	const kept = new Set(reviewEntries.map((_, i) => i));

	for (let i = 0; i < reviewEntries.length; i++) {
		if (!kept.has(i)) continue;
		for (let j = i + 1; j < reviewEntries.length; j++) {
			if (!kept.has(j)) continue;
			const sim = jaccardSimilarity(tokenSets[i], tokenSets[j]);
			if (sim >= threshold) {
				// Drop the lower-scored one; keep the higher
				const dropIndex = scores[i] >= scores[j] ? j : i;
				kept.delete(dropIndex);
			}
		}
	}

	const deduplicated = reviewEntries.filter((_, i) => kept.has(i));
	const removed = reviewEntries.length - deduplicated.length;
	return { deduplicated, removed };
}

function formatReviewSessionsForPrompt(entries) {
	return entries
		.map((entry, index) => {
			const r = entry.record;
			const date = r.evidence?.date ?? r.recorded_at ?? "unknown";
			return `### Session ${index + 1} (${date})\n${r.description ?? "(no description)"}`;
		})
		.join("\n\n---\n\n");
}

async function spawnSynthesis(root, reviewEntries) {
	const templatePath = join(root, ".github", "hooks", "prompts", "synthesise-learnings.md");
	if (!existsSync(templatePath)) {
		console.warn("synthesise-learnings.md not found — skipping synthesis");
		return false;
	}

	const template = await readFile(templatePath, "utf-8");
	const prompt = template.replace("{{reviewSessions}}", formatReviewSessionsForPrompt(reviewEntries));

	const child = spawn("copilot", ["-p", prompt, "--yolo", "--silent"], {
		cwd: root,
		detached: true,
		stdio: "ignore",
	});
	child.unref();
	return true;
}

async function markSynthesised(entries) {
	const outcome = {
		status: "pending",
		agent: "markdown-synthesise",
		notes: "Included in batch synthesis — patterns promoted via synthesise-learnings.md",
		recorded_at: new Date().toISOString(),
	};
	for (const entry of entries) {
		const updated = {
			...entry.record,
			outcomes: [...(entry.record.outcomes ?? []), outcome],
		};
		await writeFile(entry.path, `${JSON.stringify(updated, null, 2)}\n`, "utf-8");
	}
}

function computeImprovementSignal(entries) {
	// Group records by their primary durable file area
	const groups = new Map();

	for (const entry of entries) {
		const r = entry.record;
		const score = (r.outcomes ?? []).find((o) => o.agent === "markdown-eval")?.test_results;
		if (!score) continue;

		const match = score.match(/score=(\d+)\/(\d+)/);
		if (!match) continue;
		const total = Number.parseInt(match[1], 10);
		const max = Number.parseInt(match[2], 10);
		const pct = max > 0 ? total / max : 0;

		const durableFiles = (r.files ?? []).filter(isDurableFile);
		const area = durableFiles.length > 0
			? durableFiles[0].replace(/^docs\/([^/]+).*/, "docs/$1").replace(/^(AGENTS\.md)$/, "AGENTS.md")
			: "general";

		if (!groups.has(area)) groups.set(area, []);
		groups.get(area).push({ pct, recorded_at: r.recorded_at ?? "" });
	}

	const signals = [];
	for (const [area, scores] of groups) {
		if (scores.length < 3) continue;

		const sorted = [...scores].sort((a, b) => a.recorded_at.localeCompare(b.recorded_at));
		const third = Math.max(1, Math.floor(sorted.length / 3));
		const early = sorted.slice(0, third).reduce((s, x) => s + x.pct, 0) / third;
		const recent = sorted.slice(-third).reduce((s, x) => s + x.pct, 0) / third;
		const delta = recent - early;

		const trend = delta > 0.08 ? "improving ↑" : delta < -0.08 ? "declining ↓" : "stable →";
		signals.push({ area, trend, early: Math.round(early * 100), recent: Math.round(recent * 100), count: scores.length });
	}

	return signals;
}

function formatMarkdown(results, improvementSignal = []) {
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
			`- Score: ${result.score.total}/${result.score.max} (groundedness ${result.score.groundedness}, reusability ${result.score.reusability}, specificity ${result.score.specificity}, validation ${result.score.validationSignal}, semantic ${result.score.semanticQuality}${result.score.classifierPenalty > 0 ? `, classifier penalty -${result.score.classifierPenalty}` : ""})`,
		);
		if (result.alreadyEvaluated) {
			lines.push("- Existing eval outcome: yes");
		}
		if (result.alreadyPromoted) {
			lines.push("- AGENTS promotion: yes");
		}
		lines.push(`- Reasons: ${result.reasons.join("; ")}`, "");
	}

	if (improvementSignal.length > 0) {
		lines.push("## Improvement signal", "");
		for (const s of improvementSignal) {
			lines.push(`- **${s.area}**: ${s.trend} (${s.early}% → ${s.recent}% avg score, ${s.count} sessions)`);
		}
		lines.push("");
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

async function verifyPendingPromotions(entries) {
	let verified = 0;
	for (const entry of entries) {
		const pendingPromotion = (entry.record.outcomes ?? []).find(
			(o) => o.agent === "markdown-promote" && o.status === "pending",
		);
		if (!pendingPromotion) continue;

		let hasChanges = false;
		try {
			const result = execSync(
				`git log --oneline --since="${pendingPromotion.recorded_at}" -- AGENTS.md docs/`,
				{ cwd: process.cwd(), encoding: "utf-8" },
			).trim();
			hasChanges = result.length > 0;
		} catch {
			continue;
		}

		if (!hasChanges) continue;

		const updatedOutcomes = (entry.record.outcomes ?? []).map((o) =>
			o.agent === "markdown-promote" && o.status === "pending"
				? {
						...o,
						status: "success",
						notes: `${o.notes} — verified: durable docs changed after promotion`,
						verified_at: new Date().toISOString(),
					}
				: o,
		);
		await writeFile(entry.path, `${JSON.stringify({ ...entry.record, outcomes: updatedOutcomes }, null, 2)}\n`, "utf-8");
		verified += 1;
	}
	return verified;
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	const root = process.cwd();
	const entries = await readRecords(options.limit);

	// Semantic enrichment: enrich records that haven't been scored yet (stored in metadata, called once per record)
	let semanticScored = 0;
	if (options.semantic) {
		for (const entry of entries) {
			const semanticScore = await fetchSemanticScore(entry.record, root);
			if (semanticScore) {
				const updated = {
					...entry.record,
					metadata: { ...(entry.record.metadata ?? {}), semanticScore },
				};
				await writeFile(entry.path, `${JSON.stringify(updated, null, 2)}\n`, "utf-8");
				entry.record = updated;
				semanticScored += 1;
			}
		}
	}

	const results = entries.map((entry) => evaluateRecord(entry.record));

	// Improvement signal: always computed, surfaces score trends per file area
	const improvementSignal = computeImprovementSignal(entries);

	let outcomesAppended = 0;
	let promotionsSpawned = 0;
	let verificationsResolved = 0;

	if (options.recordOutcomes) {
		verificationsResolved = await verifyPendingPromotions(entries);
		for (let index = 0; index < entries.length; index += 1) {
			const appended = await appendEvalOutcome(entries[index], results[index]);
			if (appended) {
				outcomesAppended += 1;
				if (results[index].recommendation === "promote" && !results[index].alreadyPromoted) {
					await spawnPromotion(root, entries[index]);
					promotionsSpawned += 1;
				}
			}
		}
	}

	// Synthesise: batch review-tier sessions into durable patterns when threshold is met
	let synthesisBatched = 0;
	let uniqueCandidates = [];
	let jaccardRemoved = 0;
	if (options.synthesise) {
		const reviewCandidates = collectReviewCandidates(entries, results);
		({ deduplicated: uniqueCandidates, removed: jaccardRemoved } = deduplicateByJaccard(reviewCandidates, results));
		if (uniqueCandidates.length >= SYNTHESISE_MIN_RECORDS) {
			const spawned = await spawnSynthesis(root, uniqueCandidates);
			if (spawned) {
				await markSynthesised(uniqueCandidates);
				synthesisBatched = uniqueCandidates.length;
			}
		}
		if (jaccardRemoved > 0 && !options.json) {
			console.log(`\nJaccard dedup: removed ${jaccardRemoved} near-duplicate review session(s) before synthesis.`);
		}
	}

	const markdown = formatMarkdown(results, improvementSignal);
	await writeLatestEvalReport(markdown);

	if (options.json) {
		console.log(
			JSON.stringify(
				{
					success: true,
					command: "markdown-eval",
					results,
					outcomesAppended,
					semanticScored,
					synthesisBatched,
					improvementSignal,
				},
				null,
				2,
			),
		);
		return;
	}

	console.log(markdown);
	if (options.semantic && semanticScored > 0) {
		console.log(`\nSemantically scored ${semanticScored} record(s).`);
	}
	if (options.synthesise) {
		if (synthesisBatched > 0) {
			console.log(`\nBatched ${synthesisBatched} review session(s) into synthesis.`);
		} else {
			console.log(`\nSynthesis skipped — ${uniqueCandidates.length}/${SYNTHESISE_MIN_RECORDS} unique review sessions available after Jaccard dedup (need ${SYNTHESISE_MIN_RECORDS}).`);
		}
	}
	if (options.recordOutcomes) {
		console.log(`\nRecorded ${outcomesAppended} markdown-eval outcome(s).`);
		if (verificationsResolved > 0) {
			console.log(`Verified ${verificationsResolved} pending promotion(s).`);
		}
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
