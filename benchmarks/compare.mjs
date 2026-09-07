#!/usr/bin/env node

import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BENCHMARK_DIR = resolve(fileURLToPath(new URL(".", import.meta.url)));
const REPOSITORY_ROOT = resolve(BENCHMARK_DIR, "..");
const IGNORED_CONFIGURATION_KEYS = new Set([
	"warmupRuns",
	"measuredRuns",
	"minimumMeasuredRuns",
]);
const IGNORED_ENVIRONMENT_KEYS = new Set(["commit", "dirty", "timestamp"]);
const SUMMARY_STAT_KEYS = new Set([
	"median",
	"p95",
	"p99",
	"min",
	"max",
	"mean",
	"standardDeviation",
	"coefficientOfVariation",
]);

function nextArgumentValue(argv, index, flag) {
	const value = argv[index + 1];
	if (!value || value.startsWith("--")) {
		throw new Error(`${flag} requires a value`);
	}
	return value;
}

function parseArguments(argv) {
	const positional = [];
	const configuration = {};

	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--before") {
			configuration.before = nextArgumentValue(argv, index, argument);
			index += 1;
		} else if (argument === "--after") {
			configuration.after = nextArgumentValue(argv, index, argument);
			index += 1;
		} else if (argument === "--output") {
			configuration.output = nextArgumentValue(argv, index, argument);
			index += 1;
		} else if (argument === "--help" || argument === "-h") {
			configuration.help = true;
		} else if (argument.startsWith("--")) {
			throw new Error(`Unknown argument: ${argument}`);
		} else {
			positional.push(argument);
		}
	}

	if (configuration.before === undefined) configuration.before = positional[0];
	if (configuration.after === undefined) configuration.after = positional[1];
	if (positional.length > 2) {
		throw new Error("Expected a before path and an after path");
	}
	if (!configuration.help && (!configuration.before || !configuration.after)) {
		throw new Error(
			"Provide two result files/directories: <before> <after> (or --before and --after)",
		);
	}
	return configuration;
}

function printUsage() {
	console.log(`Usage:
  npm run benchmark:compare -- <before-file-or-directory> <after-file-or-directory>
  node benchmarks/compare.mjs --before <path> --after <path>
  node benchmarks/compare.mjs --before <path> --after <path> --output comparison.md

Directories may contain one result file or the result files from one benchmark run.
Run counts, commit, dirty state, and timestamp are metadata and do not block comparison.
Fixture, machine, and other critical configuration changes withhold percentage changes.`);
}

async function collectJsonFiles(inputPath) {
	const inputStat = await stat(inputPath);
	if (inputStat.isFile()) return [inputPath];
	if (!inputStat.isDirectory()) {
		throw new Error(`${inputPath} is neither a file nor a directory`);
	}

	const files = [];
	async function visit(directory) {
		const entries = await readdir(directory, { withFileTypes: true });
		entries.sort((left, right) => left.name.localeCompare(right.name));
		for (const entry of entries) {
			const entryPath = resolve(directory, entry.name);
			if (entry.isDirectory()) {
				await visit(entryPath);
			} else if (entry.isFile() && extname(entry.name).toLowerCase() === ".json") {
				files.push(entryPath);
			}
		}
	}
	await visit(inputPath);
	if (files.length === 0) {
		throw new Error(`${inputPath} contains no JSON result files`);
	}
	return files;
}

async function loadResultFile(filePath) {
	let value;
	try {
		value = JSON.parse(await readFile(filePath, "utf8"));
	} catch (error) {
		throw new Error(
			`Could not read benchmark result ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error },
		);
	}
	if (
		!value ||
		typeof value !== "object" ||
		value.schemaVersion !== 1 ||
		typeof value.suite !== "string" ||
		value.suite.length === 0
	) {
		throw new Error(
			`${filePath} is not a schemaVersion 1 benchmark result with a suite name`,
		);
	}
	return { path: filePath, result: value };
}

async function loadInput(argument) {
	const inputPath = resolve(process.cwd(), argument);
	const files = await collectJsonFiles(inputPath);
	const loaded = await Promise.all(files.map(loadResultFile));
	const results = new Map();
	for (const item of loaded) {
		const existing = results.get(item.result.suite);
		if (existing) {
			throw new Error(
				`${inputPath} contains multiple results for suite ${JSON.stringify(item.result.suite)} (${existing.path} and ${item.path}); compare one timestamp directory or file at a time`,
			);
		}
		results.set(item.result.suite, item);
	}
	return { argument, inputPath, results };
}

function omitKeys(value, ignoredKeys) {
	if (Array.isArray(value)) return value.map((item) => omitKeys(item, ignoredKeys));
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value)
			.filter(([key]) => !ignoredKeys.has(key))
			.map(([key, item]) => [key, omitKeys(item, ignoredKeys)]),
	);
}

function compareValues(before, after, path = "", differences = []) {
	if (Object.is(before, after)) return differences;
	const beforeIsObject = before && typeof before === "object";
	const afterIsObject = after && typeof after === "object";
	if (beforeIsObject && afterIsObject && Array.isArray(before) === Array.isArray(after)) {
		if (before.length !== after.length) {
			differences.push(`${path || "value"} length ${before.length} → ${after.length}`);
		}
		const keys = new Set([
			...Object.keys(before),
			...Object.keys(after),
		]);
		for (const key of [...keys].sort()) {
			compareValues(
				before[key],
				after[key],
				path ? `${path}.${key}` : key,
				differences,
			);
		}
		return differences;
	}
	differences.push(
		`${path || "value"}: ${formatValue(before)} → ${formatValue(after)}`,
	);
	return differences;
}

function configurationDifferences(beforeResult, afterResult, beforeScope, afterScope) {
	const differences = [];
	const beforeConfiguration = omitKeys(
		{ ...beforeResult.configuration, ...beforeScope.configuration },
		IGNORED_CONFIGURATION_KEYS,
	);
	const afterConfiguration = omitKeys(
		{ ...afterResult.configuration, ...afterScope.configuration },
		IGNORED_CONFIGURATION_KEYS,
	);
	compareValues(beforeConfiguration, afterConfiguration, "configuration", differences);
	return differences;
}

function environmentDifferences(before, after) {
	const beforeEnvironment = omitKeys(before.environment ?? {}, IGNORED_ENVIRONMENT_KEYS);
	const afterEnvironment = omitKeys(after.environment ?? {}, IGNORED_ENVIRONMENT_KEYS);
	return compareValues(beforeEnvironment, afterEnvironment, "environment");
}

function getScopes(result) {
	if (Array.isArray(result.scenarios)) {
		return result.scenarios.map((scenario, index) => ({
			id: String(scenario.name ?? scenario.scenario ?? `scenario-${index + 1}`),
			configuration: scenario.configuration ?? {},
			metrics: scenario.metrics ?? {},
		}));
	}
	return [
		{
			id: String(result.scenario ?? result.suite),
			label: String(result.scenario ?? result.suite),
			configuration: result.configuration ?? {},
			metrics: result.metrics ?? {},
		},
	];
}

function scopeMap(result) {
	const scopes = new Map();
	for (const scope of getScopes(result)) {
		if (scopes.has(scope.id)) {
			throw new Error(
				`Result ${result.suite} contains duplicate scenario ${JSON.stringify(scope.id)}`,
			);
		}
		scopes.set(scope.id, scope);
	}
	return scopes;
}

function flattenNumericMetrics(value, prefix = "", output = new Map()) {
	if (typeof value === "number") {
		if (Number.isFinite(value)) output.set(prefix, value);
		return output;
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return output;
	for (const key of Object.keys(value).sort()) {
		flattenNumericMetrics(value[key], prefix ? `${prefix}.${key}` : key, output);
	}
	return output;
}

function metricDirection(metricPath) {
	const metricName = metricPath.split(".")[0].toLowerCase();
	if (
		metricName.includes("throughput") ||
		metricName.includes("persecond") ||
		metricName.includes("success") ||
		metricName.includes("listenersduringeval")
	) {
		return "higher";
	}
	if (metricName === "toolcount" || metricName.includes("concurrency")) {
		return "neutral";
	}
	return "lower";
}

function metricGroupKey(path) {
	const parts = path.split(".");
	return parts.length === 2 && SUMMARY_STAT_KEYS.has(parts[1])
		? parts[0]
		: path;
}

function metricGroupLabel(path, groupKey) {
	return path === groupKey ? "" : path.slice(groupKey.length + 1);
}

function groupMetrics(metrics) {
	const groups = new Map();
	for (const metric of metrics) {
		const key = metricGroupKey(metric.path);
		const group = groups.get(key) ?? [];
		group.push(metric);
		groups.set(key, group);
	}
	return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right));
}

function groupStatus(group) {
	const statuses = new Set(group.map((metric) => metric.status));
	if (statuses.has("incompatible")) return "incompatible";
	if (["missing-before", "missing-after"].some((status) => statuses.has(status))) {
		return [...statuses].find((status) => status.startsWith("missing"));
	}
	if (statuses.size === 1) return [...statuses][0];
	return "mixed";
}

function classifyChange(beforeValue, afterValue, direction) {
	if (Object.is(beforeValue, afterValue)) return "unchanged";
	if (direction === "neutral") return "changed";
	const improved = direction === "higher"
		? afterValue > beforeValue
		: afterValue < beforeValue;
	return improved ? "improvement" : "regression";
}

function compareScope(beforeResult, afterResult, beforeScope, afterScope) {
	const reasons = [
		...configurationDifferences(beforeResult, afterResult, beforeScope, afterScope),
		...environmentDifferences(beforeResult, afterResult),
	];
	const beforeMetrics = flattenNumericMetrics(beforeScope.metrics);
	const afterMetrics = flattenNumericMetrics(afterScope.metrics);
	const paths = new Set([...beforeMetrics.keys(), ...afterMetrics.keys()]);
	const metrics = [];
	for (const path of [...paths].sort()) {
		const beforeHasValue = beforeMetrics.has(path);
		const afterHasValue = afterMetrics.has(path);
		if (!beforeHasValue || !afterHasValue) {
			metrics.push({
				path,
				before: beforeHasValue ? beforeMetrics.get(path) : null,
				after: afterHasValue ? afterMetrics.get(path) : null,
				delta: null,
				percent: null,
				status: beforeHasValue ? "missing-after" : "missing-before",
				direction: metricDirection(path),
				reasons: ["metric is missing from one result"],
			});
			continue;
		}

		const beforeValue = beforeMetrics.get(path);
		const afterValue = afterMetrics.get(path);
		const delta = afterValue - beforeValue;
		const status = reasons.length > 0
			? "incompatible"
			: classifyChange(beforeValue, afterValue, metricDirection(path));
		metrics.push({
			path,
			before: beforeValue,
			after: afterValue,
			delta,
			percent:
				reasons.length > 0
					? null
					: beforeValue === 0
						? afterValue === 0
							? 0
							: null
						: (delta / Math.abs(beforeValue)) * 100,
			status,
			direction: metricDirection(path),
			reasons,
		});
	}
	return { id: beforeScope.id, reasons: [...new Set(reasons)], metrics };
}

function formatValue(value) {
	if (value === undefined) return "missing";
	if (value === null) return "n/a";
	if (typeof value === "number") {
		return Number.isInteger(value)
			? value.toLocaleString("en-US")
			: value.toLocaleString("en-US", { maximumFractionDigits: 4 });
	}
	if (typeof value === "string") return JSON.stringify(value);
	return JSON.stringify(value);
}

function formatDelta(value) {
	if (value === null) return "n/a";
	const sign = value > 0 ? "+" : "";
	return `${sign}${formatValue(value)}`;
}

function formatPercent(value) {
	if (value === null) return "n/a";
	const sign = value > 0 ? "+" : "";
	return `${sign}${value.toFixed(2)}%`;
}

function formatMetricCell(group, groupKey, side) {
	return group
		.map((metric) => {
			const label = metricGroupLabel(metric.path, groupKey);
			return `${label ? `${label}: ` : ""}${formatValue(metric[side])}`;
		})
		.join("; ");
}

function formatMetricDeltaCell(group, groupKey) {
	return group
		.map((metric) => {
			const label = metricGroupLabel(metric.path, groupKey);
			const percent = metric.status === "incompatible" || metric.before === 0
				? null
				: metric.percent;
			return `${label ? `${label}: ` : ""}${formatDelta(metric.delta)} (${formatPercent(percent)})`;
		})
		.join("; ");
}

function escapeMarkdown(value) {
	return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

function resultLabel(item) {
	return relative(REPOSITORY_ROOT, item.path).replaceAll("\\", "/");
}

function compareInputs(beforeInput, afterInput) {
	const suites = new Set([
		...beforeInput.results.keys(),
		...afterInput.results.keys(),
	]);
	const suiteComparisons = [];
	const missing = [];
	for (const suite of [...suites].sort()) {
		const beforeItem = beforeInput.results.get(suite);
		const afterItem = afterInput.results.get(suite);
		if (!beforeItem) {
			missing.push({ suite, side: "before", detail: resultLabel(afterItem) });
			continue;
		}
		if (!afterItem) {
			missing.push({ suite, side: "after", detail: resultLabel(beforeItem) });
			continue;
		}

		const beforeScopes = scopeMap(beforeItem.result);
		const afterScopes = scopeMap(afterItem.result);
		const scopeIds = new Set([
			...beforeScopes.keys(),
			...afterScopes.keys(),
		]);
		const scopes = [];
		for (const id of [...scopeIds].sort()) {
			const beforeScope = beforeScopes.get(id);
			const afterScope = afterScopes.get(id);
			if (!beforeScope) {
				missing.push({ suite, scenario: id, side: "before" });
				continue;
			}
			if (!afterScope) {
				missing.push({ suite, scenario: id, side: "after" });
				continue;
			}
			scopes.push(compareScope(beforeItem.result, afterItem.result, beforeScope, afterScope));
		}
		suiteComparisons.push({ suite, beforeItem, afterItem, scopes });
	}
	return { suiteComparisons, missing };
}

function formatReport(beforeInput, afterInput, comparison) {
	const lines = [
		"# Benchmark comparison",
		"",
		`Before: \`${escapeMarkdown(beforeInput.argument)}\``,
		`After: \`${escapeMarkdown(afterInput.argument)}\``,
		"",
		"| Suite / scenario | Metric | Before | After | Δ (absolute; %) | Status |",
		"| --- | --- | ---: | ---: | ---: | --- |",
	];
	let meaningfulChanges = 0;
	let comparableMetrics = 0;
	for (const suiteComparison of comparison.suiteComparisons) {
		for (const scope of suiteComparison.scopes) {
			for (const [groupKey, group] of groupMetrics(scope.metrics)) {
				const label = scope.id === suiteComparison.suite
					? suiteComparison.suite
					: `${suiteComparison.suite} / ${scope.id}`;
				const status = groupStatus(group);
				lines.push(
					`| ${escapeMarkdown(label)} | ${escapeMarkdown(groupKey)} | ${escapeMarkdown(formatMetricCell(group, groupKey, "before"))} | ${escapeMarkdown(formatMetricCell(group, groupKey, "after"))} | ${escapeMarkdown(formatMetricDeltaCell(group, groupKey))} | ${status} |`,
				);
				if (status !== "unchanged") meaningfulChanges += 1;
				if (status !== "incompatible" && !status.startsWith("missing")) {
					comparableMetrics += 1;
				}
			}
		}
	}

	lines.push("");
	if (comparison.missing.length > 0) {
		lines.push("## Missing scenarios");
		lines.push("");
		for (const item of comparison.missing) {
			lines.push(
				`- **${escapeMarkdown(item.suite)}${item.scenario ? ` / ${escapeMarkdown(item.scenario)}` : ""}** is missing from the ${item.side} result${item.detail ? ` (${escapeMarkdown(item.detail)})` : ""}.`,
			);
		}
		lines.push("");
	}

	const incompatibilities = [];
	for (const suiteComparison of comparison.suiteComparisons) {
		for (const scope of suiteComparison.scopes) {
			if (scope.reasons.length > 0) {
				incompatibilities.push({
					label: `${suiteComparison.suite} / ${scope.id}`,
					reasons: scope.reasons,
				});
			}
		}
	}
	if (incompatibilities.length > 0) {
		lines.push("## Percentage comparison withheld");
		lines.push("");
		for (const item of incompatibilities) {
			lines.push(
				`- **${escapeMarkdown(item.label)}**: ${item.reasons.map(escapeMarkdown).join("; ")}.`,
			);
		}
		lines.push("");
	}

	if (meaningfulChanges === 0 && comparison.missing.length === 0) {
		lines.push("No meaningful changes detected in shared metrics.");
	} else {
		lines.push(
			`${meaningfulChanges} non-unchanged metric${meaningfulChanges === 1 ? "" : "s"}; ${comparableMetrics} comparable metric${comparableMetrics === 1 ? "" : "s"}.`,
		);
	}
	return `${lines.join("\n")}\n`;
}

async function main() {
	const configuration = parseArguments(process.argv.slice(2));
	if (configuration.help) return printUsage();
	const [beforeInput, afterInput] = await Promise.all([
		loadInput(configuration.before),
		loadInput(configuration.after),
	]);
	const comparison = compareInputs(beforeInput, afterInput);
	const report = formatReport(beforeInput, afterInput, comparison);
	if (configuration.output) {
		const outputPath = resolve(process.cwd(), configuration.output);
		await writeFile(outputPath, report, "utf8");
		console.log(`Wrote ${outputPath}`);
	} else {
		process.stdout.write(report);
	}
}

export {
	compareInputs,
	compareScope,
	flattenNumericMetrics,
	formatReport,
	loadInput,
	parseArguments,
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.stack ?? error.message : error);
		process.exitCode = 1;
	});
}
