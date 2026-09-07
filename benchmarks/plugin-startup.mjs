#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { arch, cpus, platform, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { summarize } from "./stats.mjs";

const BENCHMARK_DIR = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(BENCHMARK_DIR, "..");
const PLUGIN_CODE_PATH = join(
	REPOSITORY_ROOT,
	"figma-desktop-bridge",
	"code.js",
);
const RESULTS_DIR = join(BENCHMARK_DIR, "results");
const BASELINE_PATH = join(BENCHMARK_DIR, "baselines", "plugin-startup.json");
const DEFAULT_WARMUP_RUNS = 1;
const DEFAULT_MEASURED_RUNS = 20;
const PAGE_LOAD_MS_PER_PAGE = 5;
const PAGE_TIERS = [5, 25, 100];
const PLUGIN_STARTUP_FIXTURE_VERSION = "plugin-startup-v1";

function parseNonNegativeInteger(value, flag) {
	const parsed = Number.parseInt(value, 10);
	if (!Number.isSafeInteger(parsed) || parsed < 0) {
		throw new Error(`${flag} must be a non-negative integer`);
	}
	return parsed;
}

function nextArgumentValue(argv, index, flag) {
	const value = argv[index + 1];
	if (!value || value.startsWith("--")) {
		throw new Error(`${flag} requires a value`);
	}
	return value;
}

function parseArguments(argv) {
	const configuration = {
		warmupRuns: DEFAULT_WARMUP_RUNS,
		measuredRuns: DEFAULT_MEASURED_RUNS,
	};

	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--warmup-runs") {
			configuration.warmupRuns = parseNonNegativeInteger(
				nextArgumentValue(argv, index, argument),
				argument,
			);
			index += 1;
		} else if (argument === "--runs") {
			configuration.measuredRuns = parseNonNegativeInteger(
				nextArgumentValue(argv, index, argument),
				argument,
			);
			index += 1;
		} else if (argument === "--promote") {
			configuration.promote = nextArgumentValue(argv, index, argument);
			index += 1;
		} else if (argument === "--help" || argument === "-h") {
			configuration.help = true;
		} else {
			throw new Error(`Unknown argument: ${argument}`);
		}
	}

	if (!configuration.promote && configuration.measuredRuns === 0) {
		throw new Error("--runs must be at least 1");
	}
	return configuration;
}

function printUsage() {
	console.log(`Usage:
  npm run benchmark:plugin-startup
  node benchmarks/plugin-startup.mjs --warmup-runs 0 --runs 5
  node benchmarks/plugin-startup.mjs --promote benchmarks/results/<timestamp>/plugin-startup.json

The promotion command copies one explicitly chosen result to:
  benchmarks/baselines/plugin-startup.json`);
}

function gitOutput(args, fallback = "unknown") {
	try {
		return execFileSync("git", args, {
			cwd: REPOSITORY_ROOT,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return fallback;
	}
}

async function getEnvironment() {
	const packageJson = JSON.parse(
		await readFile(join(REPOSITORY_ROOT, "package.json"), "utf8"),
	);
	return {
		commit: gitOutput(["rev-parse", "--short", "HEAD"]),
		dirty: gitOutput(["status", "--porcelain"], "") !== "",
		os: platform(),
		arch: arch(),
		node: process.version,
		packageVersion: packageJson.version,
		cpu: cpus()[0]?.model?.trim() ?? "unknown",
		memoryMb: Math.round(totalmem() / 1024 / 1024),
		timestamp: new Date().toISOString(),
	};
}

function round(value, digits = 4) {
	return Number(value.toFixed(digits));
}

function roundedSummary(values) {
	return Object.fromEntries(
		Object.entries(summarize(values)).map(([key, value]) => [
			key,
			round(value),
		]),
	);
}

function delay(ms) {
	return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function waitFor(predicate, timeoutMs, label) {
	const startedAt = performance.now();
	return new Promise((resolve, reject) => {
		const tick = () => {
			if (predicate()) {
				resolve();
				return;
			}
			if (performance.now() - startedAt > timeoutMs) {
				reject(new Error(`${label} timed out after ${timeoutMs}ms`));
				return;
			}
			setImmediate(tick);
		};
		tick();
	});
}

function createSilentConsole() {
	const noop = () => {};
	return {
		log: noop,
		info: noop,
		warn: noop,
		error: noop,
		debug: noop,
	};
}

function createFakeFigma({ pageCount, pageLoadDelayMs }) {
	const listeners = {
		documentchange: [],
		selectionchange: [],
		currentpagechange: [],
	};
	let loadAllPagesCalls = 0;
	const pages = Array.from({ length: pageCount }, (_, index) => ({
		id: `${index}:0`,
		name: index === 0 ? "Page 1" : `Page ${index + 1}`,
		type: "PAGE",
		children: [],
		selection: [],
	}));

	const figma = {
		editorType: "figma",
		fileKey: "plugin-startup-bench",
		mixed: "MIXED",
		root: { name: "Plugin Startup Fixture", children: pages },
		currentPage: pages[0],
		showUI() {},
		ui: {
			postMessage() {},
			resize() {},
			onmessage: null,
		},
		clientStorage: {
			getAsync: async () => null,
			setAsync: async () => {},
		},
		variables: {
			getLocalVariablesAsync: async () => [],
			getLocalVariableCollectionsAsync: async () => [],
		},
		on(event, handler) {
			if (!listeners[event]) listeners[event] = [];
			listeners[event].push(handler);
		},
		loadAllPagesAsync() {
			loadAllPagesCalls += 1;
			return delay(pageLoadDelayMs);
		},
		get loadAllPagesCalls() {
			return loadAllPagesCalls;
		},
		get listeners() {
			return listeners;
		},
	};

	return figma;
}

function createSandbox(figma) {
	return vm.createContext({
		figma,
		__html__: "<html></html>",
		console: createSilentConsole(),
		performance,
		setTimeout,
		clearTimeout,
		setInterval,
		clearInterval,
		Date,
		JSON,
		Math,
		Number,
		String,
		Boolean,
		Array,
		Object,
		Error,
		TypeError,
		RangeError,
		Promise,
		parseInt,
		parseFloat,
		isNaN,
		isFinite,
		Infinity,
		NaN,
		undefined,
		Uint8Array,
		Map,
		Set,
		WeakMap,
	});
}

function listenerCount(figma, event) {
	return figma.listeners[event] ? figma.listeners[event].length : 0;
}

async function deliverPluginMessage(sandbox, message) {
	const onmessage = sandbox.figma.ui.onmessage;
	if (typeof onmessage !== "function") {
		throw new Error("Plugin worker did not install figma.ui.onmessage");
	}
	await onmessage(message);
}

async function runIteration(script, pageCount, pageLoadDelayMs) {
	const figma = createFakeFigma({ pageCount, pageLoadDelayMs });
	const sandbox = createSandbox(figma);
	const cpuStarted = process.cpuUsage();
	const heapStarted = process.memoryUsage().heapUsed;
	const evalStarted = performance.now();

	script.runInContext(sandbox);

	const evalMs = performance.now() - evalStarted;
	const loadAllPagesCallsDuringEval = figma.loadAllPagesCalls;
	const selectionDuringEval = listenerCount(figma, "selectionchange");
	const pageDuringEval = listenerCount(figma, "currentpagechange");
	const documentDuringEval = listenerCount(figma, "documentchange");

	await waitFor(
		() => listenerCount(figma, "selectionchange") > 0,
		pageLoadDelayMs + 2_000,
		"selection listener registration",
	);
	const selectionReadyMs = performance.now() - evalStarted;

	await waitFor(
		() => listenerCount(figma, "currentpagechange") > 0,
		pageLoadDelayMs + 2_000,
		"page listener registration",
	);
	const pageReadyMs = performance.now() - evalStarted;

	const loadAllPagesCallsAtSelectionReady = figma.loadAllPagesCalls;
	const documentChangeAtSelectionReady = listenerCount(
		figma,
		"documentchange",
	);

	await delay(Math.min(25, Math.max(5, pageLoadDelayMs)));
	const loadAllPagesCallsAfterQuietPeriod = figma.loadAllPagesCalls;
	const documentChangeAfterQuietPeriod = listenerCount(
		figma,
		"documentchange",
	);

	const activationStarted = performance.now();
	let activatedByCommand = false;
	if (typeof sandbox.__ensureDocumentChangeTracking === "function") {
		activatedByCommand = true;
		await sandbox.__ensureDocumentChangeTracking("plugin-startup-bench");
	} else {
		await deliverPluginMessage(sandbox, {
			type: "ENSURE_DOCUMENT_CHANGE_TRACKING",
			requestId: "plugin-startup-bench",
		});
		if (listenerCount(figma, "documentchange") === 0) {
			await waitFor(
				() => listenerCount(figma, "documentchange") > 0,
				pageLoadDelayMs + 2_000,
				"documentchange listener registration",
			);
		}
	}
	const changeTrackingReadyMs = performance.now() - evalStarted;
	const changeTrackingActivationMs = performance.now() - activationStarted;

	if (typeof sandbox.__ensureDocumentChangeTracking === "function") {
		await sandbox.__ensureDocumentChangeTracking("plugin-startup-repeat");
	} else {
		await deliverPluginMessage(sandbox, {
			type: "ENSURE_DOCUMENT_CHANGE_TRACKING",
			requestId: "plugin-startup-repeat",
		});
	}

	const cpu = process.cpuUsage(cpuStarted);
	return {
		evalMs: round(evalMs),
		selectionReadyMs: round(selectionReadyMs),
		pageReadyMs: round(pageReadyMs),
		changeTrackingReadyMs: round(changeTrackingReadyMs),
		changeTrackingActivationMs: round(changeTrackingActivationMs),
		loadAllPagesCallsDuringEval,
		loadAllPagesCallsAtSelectionReady,
		loadAllPagesCallsAfterQuietPeriod,
		loadAllPagesCallsAfterActivation: figma.loadAllPagesCalls,
		selectionListenersDuringEval: selectionDuringEval,
		pageListenersDuringEval: pageDuringEval,
		documentListenersDuringEval: documentDuringEval,
		selectionListeners: listenerCount(figma, "selectionchange"),
		pageListeners: listenerCount(figma, "currentpagechange"),
		documentListenersAtSelectionReady: documentChangeAtSelectionReady,
		documentListenersAfterQuietPeriod: documentChangeAfterQuietPeriod,
		documentListeners: listenerCount(figma, "documentchange"),
		activatedByCommand,
		cpuMs: round((cpu.user + cpu.system) / 1000),
		heapDeltaMb: round((process.memoryUsage().heapUsed - heapStarted) / 1024 / 1024),
		peakRssMb: round(process.memoryUsage().rss / 1024 / 1024),
	};
}

function invariantValue(samples, key) {
	const values = new Set(samples.map((sample) => sample[key]));
	if (values.size !== 1) {
		throw new Error(
			`${key} changed between measured runs: ${[...values].join(", ")}`,
		);
	}
	return samples[0][key];
}

async function runScenario(script, pageCount, configuration) {
	const pageLoadDelayMs = pageCount * PAGE_LOAD_MS_PER_PAGE;
	const name = `pages-${pageCount}-startup`;
	const totalRuns = configuration.warmupRuns + configuration.measuredRuns;
	const samples = [];

	for (let index = 0; index < totalRuns; index += 1) {
		const warmup = index < configuration.warmupRuns;
		process.stdout.write(
			`${warmup ? "Warm-up" : "Measured"} ${name} ${warmup ? index + 1 : index - configuration.warmupRuns + 1}/${warmup ? configuration.warmupRuns : configuration.measuredRuns}... `,
		);
		const sample = await runIteration(script, pageCount, pageLoadDelayMs);
		console.log(
			`${sample.selectionReadyMs.toFixed(2)} ms selection-ready, ${sample.loadAllPagesCallsDuringEval} loadAllPages at eval`,
		);
		if (!warmup) samples.push(sample);
	}

	return {
		name,
		configuration: {
			pageCount,
			pageLoadDelayMs,
			pageLoadMsPerPage: PAGE_LOAD_MS_PER_PAGE,
			fixtureVersion: PLUGIN_STARTUP_FIXTURE_VERSION,
			warmupRuns: configuration.warmupRuns,
			measuredRuns: configuration.measuredRuns,
		},
		metrics: {
			evalMs: roundedSummary(samples.map((sample) => sample.evalMs)),
			selectionReadyMs: roundedSummary(
				samples.map((sample) => sample.selectionReadyMs),
			),
			pageReadyMs: roundedSummary(samples.map((sample) => sample.pageReadyMs)),
			changeTrackingReadyMs: roundedSummary(
				samples.map((sample) => sample.changeTrackingReadyMs),
			),
			changeTrackingActivationMs: roundedSummary(
				samples.map((sample) => sample.changeTrackingActivationMs),
			),
			cpuMs: roundedSummary(samples.map((sample) => sample.cpuMs)),
			heapDeltaMb: roundedSummary(samples.map((sample) => sample.heapDeltaMb)),
			peakRssMb: roundedSummary(samples.map((sample) => sample.peakRssMb)),
			loadAllPagesCallsDuringEval: invariantValue(
				samples,
				"loadAllPagesCallsDuringEval",
			),
			loadAllPagesCallsAtSelectionReady: invariantValue(
				samples,
				"loadAllPagesCallsAtSelectionReady",
			),
			loadAllPagesCallsAfterQuietPeriod: invariantValue(
				samples,
				"loadAllPagesCallsAfterQuietPeriod",
			),
			loadAllPagesCallsAfterActivation: invariantValue(
				samples,
				"loadAllPagesCallsAfterActivation",
			),
			selectionListenersDuringEval: invariantValue(
				samples,
				"selectionListenersDuringEval",
			),
			pageListenersDuringEval: invariantValue(
				samples,
				"pageListenersDuringEval",
			),
			documentListenersDuringEval: invariantValue(
				samples,
				"documentListenersDuringEval",
			),
			selectionListeners: invariantValue(samples, "selectionListeners"),
			pageListeners: invariantValue(samples, "pageListeners"),
			documentListeners: invariantValue(samples, "documentListeners"),
			documentListenersAtSelectionReady: invariantValue(
				samples,
				"documentListenersAtSelectionReady",
			),
			documentListenersAfterQuietPeriod: invariantValue(
				samples,
				"documentListenersAfterQuietPeriod",
			),
			activatedByCommand: invariantValue(samples, "activatedByCommand"),
		},
		samples,
	};
}

function printSummary(result, outputPath) {
	console.log(
		"\n| Scenario | Selection ready | p95 | loadAllPages at eval | Document listeners at eval |",
	);
	console.log("| --- | ---: | ---: | ---: | ---: |");
	for (const scenario of result.scenarios) {
		console.log(
			`| ${scenario.name} | ${scenario.metrics.selectionReadyMs.median.toFixed(2)} ms | ${scenario.metrics.selectionReadyMs.p95.toFixed(2)} ms | ${scenario.metrics.loadAllPagesCallsDuringEval} | ${scenario.metrics.documentListenersDuringEval} |`,
		);
	}
	console.log(`\nResult: ${outputPath}`);
}

async function promoteResult(sourceArgument) {
	if (!sourceArgument) throw new Error("--promote requires a result JSON path");
	const sourcePath = resolve(REPOSITORY_ROOT, sourceArgument);
	const result = JSON.parse(await readFile(sourcePath, "utf8"));
	if (result.schemaVersion !== 1 || result.suite !== "plugin-startup") {
		throw new Error(`${sourcePath} is not a plugin-startup benchmark result`);
	}
	await mkdir(dirname(BASELINE_PATH), { recursive: true });
	await copyFile(sourcePath, BASELINE_PATH);
	console.log(`Promoted ${sourcePath} to ${BASELINE_PATH}`);
}

async function main() {
	const configuration = parseArguments(process.argv.slice(2));
	if (configuration.help) {
		printUsage();
		return;
	}
	if (configuration.promote) {
		await promoteResult(configuration.promote);
		return;
	}

	const codeSource = await readFile(PLUGIN_CODE_PATH, "utf8");
	const script = new vm.Script(codeSource, { filename: "code.js" });

	console.log(
		`Plugin startup benchmark: ${configuration.warmupRuns} warm-up, ${configuration.measuredRuns} measured runs`,
	);

	const scenarios = [];
	for (const pageCount of PAGE_TIERS) {
		scenarios.push(await runScenario(script, pageCount, configuration));
	}

	const environment = await getEnvironment();
	const timestampDirectory = environment.timestamp.replace(/[:.]/g, "-");
	const outputPath = join(
		RESULTS_DIR,
		timestampDirectory,
		"plugin-startup.json",
	);
	const result = {
		schemaVersion: 1,
		suite: "plugin-startup",
		scenario: "deferred-all-page-loading",
		environment,
		configuration: {
			warmupRuns: configuration.warmupRuns,
			measuredRuns: configuration.measuredRuns,
			pageTiers: PAGE_TIERS,
			pageLoadMsPerPage: PAGE_LOAD_MS_PER_PAGE,
			fixtureVersion: PLUGIN_STARTUP_FIXTURE_VERSION,
			pluginPath: "figma-desktop-bridge/code.js",
			percentileMethod: "linear interpolation between adjacent ranks",
			hardLimits: {
				maxSelectionListeners: 1,
				maxPageListeners: 1,
				maxDocumentListeners: 1,
			},
		},
		scenarios,
		correctness: {
			noDuplicateSelectionListeners: scenarios.every(
				(scenario) => scenario.metrics.selectionListeners === 1,
			),
			noDuplicatePageListeners: scenarios.every(
				(scenario) => scenario.metrics.pageListeners === 1,
			),
			noDuplicateDocumentListeners: scenarios.every(
				(scenario) => scenario.metrics.documentListeners === 1,
			),
			singleLoadAllPagesAfterActivation: scenarios.every(
				(scenario) => scenario.metrics.loadAllPagesCallsAfterActivation === 1,
			),
			noLoadAllPagesDuringEval: scenarios.every(
				(scenario) => scenario.metrics.loadAllPagesCallsDuringEval === 0,
			),
			selectionListenersReadyDuringEval: scenarios.every(
				(scenario) => scenario.metrics.selectionListenersDuringEval === 1,
			),
			noDocumentListenersUntilActivation: scenarios.every(
				(scenario) =>
					scenario.metrics.documentListenersDuringEval === 0 &&
					scenario.metrics.documentListenersAfterQuietPeriod === 0,
			),
		},
	};

	if (
		!result.correctness.noDuplicateSelectionListeners ||
		!result.correctness.noDuplicatePageListeners ||
		!result.correctness.noDuplicateDocumentListeners ||
		!result.correctness.singleLoadAllPagesAfterActivation ||
		!result.correctness.noLoadAllPagesDuringEval ||
		!result.correctness.selectionListenersReadyDuringEval ||
		!result.correctness.noDocumentListenersUntilActivation
	) {
		throw new Error(
			"Plugin startup benchmark failed listener, loadAllPages, or deferred-activation checks",
		);
	}

	await mkdir(dirname(outputPath), { recursive: true });
	await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
	printSummary(result, outputPath);
}

main().catch((error) => {
	console.error(
		error instanceof Error ? (error.stack ?? error.message) : error,
	);
	process.exitCode = 1;
});
