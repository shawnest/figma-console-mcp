#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { arch, cpus, platform, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import {
	createDesignSystemFixture,
	createFakeFigmaAPI,
	DESIGN_SYSTEM_FIXTURE_VERSION,
} from "./fixtures/design-system.mjs";
import { summarize } from "./stats.mjs";

process.env.LOG_LEVEL ??= "error";

const BENCHMARK_DIR = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(BENCHMARK_DIR, "..");
const RESULTS_DIR = join(BENCHMARK_DIR, "results");
const BASELINE_PATH = join(BENCHMARK_DIR, "baselines", "design-system.json");
const DEFAULT_WARMUP_RUNS = 1;
const DEFAULT_MEASURED_RUNS = 20;
const FILE_KEY = "syntheticDesignSystemFile";
const FILE_URL = `https://www.figma.com/design/${FILE_KEY}/Synthetic-Design-System`;
// These limits protect deterministic output shape and request behavior. They
// are intentionally independent of wall-time and memory variance.
const MAX_REST_REQUESTS_PER_SCENARIO = 64;
const MAX_COMPACT_RESPONSE_BYTES = 100 * 1024;

function nonNegativeInteger(value, flag) {
	const parsed = Number.parseInt(value, 10);
	if (!Number.isSafeInteger(parsed) || parsed < 0) {
		throw new Error(`${flag} must be a non-negative integer`);
	}
	return parsed;
}

function nextArgumentValue(argv, index, flag) {
	const value = argv[index + 1];
	if (!value || value.startsWith("--"))
		throw new Error(`${flag} requires a value`);
	return value;
}

function parseArguments(argv) {
	const configuration = {
		warmupRuns: DEFAULT_WARMUP_RUNS,
		measuredRuns: DEFAULT_MEASURED_RUNS,
		latencyMs: 2,
		jitterMs: 1,
		latencyMode: "seeded",
	};
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--warmup-runs") {
			configuration.warmupRuns = nonNegativeInteger(
				nextArgumentValue(argv, index, argument),
				argument,
			);
			index += 1;
		} else if (argument === "--runs") {
			configuration.measuredRuns = nonNegativeInteger(
				nextArgumentValue(argv, index, argument),
				argument,
			);
			index += 1;
		} else if (argument === "--latency-ms") {
			configuration.latencyMs = nonNegativeInteger(
				nextArgumentValue(argv, index, argument),
				argument,
			);
			index += 1;
		} else if (argument === "--jitter-ms") {
			configuration.jitterMs = nonNegativeInteger(
				nextArgumentValue(argv, index, argument),
				argument,
			);
			index += 1;
		} else if (argument === "--latency-mode") {
			configuration.latencyMode = nextArgumentValue(argv, index, argument);
			if (!["fixed", "seeded"].includes(configuration.latencyMode)) {
				throw new Error("--latency-mode must be fixed or seeded");
			}
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
  npm run benchmark:design-system
  node --expose-gc benchmarks/design-system.mjs --warmup-runs 0 --runs 1
  node benchmarks/design-system.mjs --latency-mode fixed --latency-ms 5 --jitter-ms 0
  node benchmarks/design-system.mjs --promote benchmarks/results/<timestamp>/design-system.json

The benchmark covers three deterministic fixture tiers, cache miss/hit, response
formats, images, and one in-process MCP client/server round trip.

The promotion command copies one explicitly chosen result to:
  benchmarks/baselines/design-system.json`);
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

function toMb(bytes) {
	return bytes / 1024 / 1024;
}

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

function expectedComponentItemCounts(fixture) {
	const standalone = fixture.componentCount - fixture.componentSetCount;
	// Large full responses auto-compress to compact as well, so the same
	// standalone cap applies even when the requested format was full/summary.
	return standalone > 100
		? [fixture.componentCount, fixture.componentSetCount + 100]
		: [fixture.componentCount];
}

function validateKit(kit, fixture, scenario) {
	const include = scenario.args.include;
	assert(kit.fileKey === FILE_KEY, `${scenario.name}: wrong file key`);
	assert(
		typeof kit.ai_instruction === "string" && kit.ai_instruction.length > 0,
		`${scenario.name}: missing AI instruction`,
	);
	if (include.includes("tokens")) {
		assert(kit.tokens, `${scenario.name}: tokens section missing`);
		assert(
			kit.tokens.summary.totalVariables === fixture.variableCount,
			`${scenario.name}: token count mismatch`,
		);
		assert(
			kit.tokens.summary.totalCollections === 4,
			`${scenario.name}: collection count mismatch`,
		);
	}
	if (include.includes("components")) {
		assert(kit.components, `${scenario.name}: components section missing`);
		assert(
			kit.components.summary.totalComponentSets === fixture.componentSetCount,
			`${scenario.name}: component-set count mismatch`,
		);
		assert(
			expectedComponentItemCounts(fixture).includes(
				kit.components.items.length,
			),
			`${scenario.name}: component item count mismatch`,
		);
		assert(
			kit.components.summary.totalComponents === kit.components.items.length,
			`${scenario.name}: component summary count mismatch`,
		);
		assert(
			kit.components.items.some(
				(item) =>
					item.variants?.length > 0 || item.name?.startsWith("Component Set"),
			),
			`${scenario.name}: component-set fixture missing`,
		);
		assert(
			kit.components.items.some((item) => item.properties),
			`${scenario.name}: essential component fields missing`,
		);
	}
	if (include.includes("styles")) {
		assert(kit.styles, `${scenario.name}: styles section missing`);
		assert(
			kit.styles.summary.totalStyles === fixture.styleCount,
			`${scenario.name}: style count mismatch`,
		);
	}
}

function currentMemory() {
	const usage = process.memoryUsage();
	return { heapUsed: usage.heapUsed, rss: usage.rss };
}

async function executeDirect({
	assembleDesignSystemKit,
	fixture,
	api,
	scenario,
	cache,
	designSystemCache,
}) {
	const operation = api.beginOperation();
	if (globalThis.gc) globalThis.gc();
	const memoryBefore = currentMemory();
	const cpuBefore = process.cpuUsage();
	const wallStartedAt = performance.now();
	const kit = await assembleDesignSystemKit({
		api,
		fileKey: FILE_KEY,
		include: scenario.args.include,
		componentIds: scenario.args.componentIds,
		includeImages: scenario.args.includeImages,
		format: scenario.args.format,
		variablesCache: cache,
		designSystemCache,
		now: () => "2026-01-01T00:00:00.000Z",
	});
	const responseText = JSON.stringify(kit);
	validateKit(kit, fixture, scenario);
	const wallMs = performance.now() - wallStartedAt;
	const cpu = process.cpuUsage(cpuBefore);
	const memoryAfter = currentMemory();
	const io = api.endOperation(operation);
	assert(
		io.requestCount <= MAX_REST_REQUESTS_PER_SCENARIO,
		`${scenario.name}: REST request count ${io.requestCount} exceeds the ${MAX_REST_REQUESTS_PER_SCENARIO}-request smoke limit`,
	);
	const responseBytes = Buffer.byteLength(responseText, "utf8");
	assert(
		scenario.args.format !== "compact" || responseBytes <= MAX_COMPACT_RESPONSE_BYTES,
		`${scenario.name}: compact response is ${responseBytes} bytes, above the ${MAX_COMPACT_RESPONSE_BYTES}-byte smoke limit`,
	);
	if (globalThis.gc) globalThis.gc();
	return {
		wallMs: round(wallMs),
		cpuMs: round((cpu.user + cpu.system) / 1000),
		restWaitMs: round(io.simulatedRestWaitMs),
		restCriticalPathMs: round(io.simulatedRestCriticalPathMs),
		localProcessingMs: round(wallMs - io.simulatedRestCriticalPathMs),
		restRequestCount: io.requestCount,
		maxRestConcurrency: io.maxConcurrency,
		restRequests: io.requests,
		responseBytes,
		heapDeltaMb: round(toMb(memoryAfter.heapUsed - memoryBefore.heapUsed)),
		peakRssMb: round(toMb(Math.max(memoryBefore.rss, memoryAfter.rss))),
	};
}

async function createMcpRoundTrip(
	api,
	registerDesignSystemTools,
	McpServer,
	Client,
	InMemoryTransport,
) {
	const server = new McpServer({
		name: "design-system-benchmark",
		version: "1.0.0",
	});
	registerDesignSystemTools(
		server,
		async () => api,
		() => FILE_URL,
		undefined,
	);
	const [clientTransport, serverTransport] =
		InMemoryTransport.createLinkedPair();
	const client = new Client(
		{ name: "design-system-benchmark-client", version: "1.0.0" },
		{ capabilities: {} },
	);
	await server.connect(serverTransport);
	await client.connect(clientTransport);
	return {
		call: (args) =>
			client.callTool({ name: "figma_get_design_system_kit", arguments: args }),
		close: async () => {
			await client.close().catch(() => {});
			await server.close().catch(() => {});
		},
	};
}

async function executeMcp({ fixture, api, scenario, mcp }) {
	const operation = api.beginOperation();
	if (globalThis.gc) globalThis.gc();
	const memoryBefore = currentMemory();
	const cpuBefore = process.cpuUsage();
	const wallStartedAt = performance.now();
	const result = await mcp.call(scenario.args);
	const textContent = result.content?.find(
		(content) => content.type === "text",
	)?.text;
	assert(
		typeof textContent === "string",
		`${scenario.name}: MCP response had no text content`,
	);
	const kit = JSON.parse(textContent);
	validateKit(kit, fixture, scenario);
	const responseText = JSON.stringify(result);
	const wallMs = performance.now() - wallStartedAt;
	const cpu = process.cpuUsage(cpuBefore);
	const memoryAfter = currentMemory();
	const io = api.endOperation(operation);
	assert(
		io.requestCount <= MAX_REST_REQUESTS_PER_SCENARIO,
		`${scenario.name}: REST request count ${io.requestCount} exceeds the ${MAX_REST_REQUESTS_PER_SCENARIO}-request smoke limit`,
	);
	const responseBytes = Buffer.byteLength(responseText, "utf8");
	assert(
		scenario.args.format !== "compact" || responseBytes <= MAX_COMPACT_RESPONSE_BYTES,
		`${scenario.name}: compact response is ${responseBytes} bytes, above the ${MAX_COMPACT_RESPONSE_BYTES}-byte smoke limit`,
	);
	if (globalThis.gc) globalThis.gc();
	return {
		wallMs: round(wallMs),
		cpuMs: round((cpu.user + cpu.system) / 1000),
		restWaitMs: round(io.simulatedRestWaitMs),
		restCriticalPathMs: round(io.simulatedRestCriticalPathMs),
		localProcessingMs: round(wallMs - io.simulatedRestCriticalPathMs),
		restRequestCount: io.requestCount,
		maxRestConcurrency: io.maxConcurrency,
		restRequests: io.requests,
		responseBytes,
		heapDeltaMb: round(toMb(memoryAfter.heapUsed - memoryBefore.heapUsed)),
		peakRssMb: round(toMb(Math.max(memoryBefore.rss, memoryAfter.rss))),
	};
}

async function runScenario({
	assembleDesignSystemKit,
	DesignSystemKitCache,
	registerDesignSystemTools,
	McpServer,
	Client,
	InMemoryTransport,
	fixture,
	configuration,
	scenario,
}) {
	const api = createFakeFigmaAPI(fixture, {
		latencyMs: configuration.latencyMs,
		jitterMs: configuration.jitterMs,
		seed: fixture.seed + scenario.name.length,
		mode: configuration.latencyMode,
	});
	let cache;
	let designSystemCache;
	if (scenario.cacheMode === "hit") {
		cache = new Map();
		const primeOperation = api.beginOperation();
		await assembleDesignSystemKit({
			api,
			fileKey: FILE_KEY,
			include: scenario.args.include,
			format: scenario.args.format,
			variablesCache: cache,
			now: () => "2026-01-01T00:00:00.000Z",
		});
		api.endOperation(primeOperation);
	} else if (scenario.cacheMode === "miss") {
		cache = new Map();
	}
	if (scenario.designSystemCacheMode === "hit") {
		designSystemCache = new DesignSystemKitCache();
		const primeOperation = api.beginOperation();
		await assembleDesignSystemKit({
			api,
			fileKey: FILE_KEY,
			include: scenario.args.include,
			componentIds: scenario.args.componentIds,
			includeImages: scenario.args.includeImages,
			format: scenario.args.format,
			variablesCache: cache,
			designSystemCache,
			now: () => "2026-01-01T00:00:00.000Z",
		});
		api.endOperation(primeOperation);
	} else if (scenario.designSystemCacheMode === "miss") {
		designSystemCache = new DesignSystemKitCache();
	}

	const execute = scenario.mcp
		? async () => {
				const mcp = await createMcpRoundTrip(
					api,
					registerDesignSystemTools,
					McpServer,
					Client,
					InMemoryTransport,
				);
				try {
					return await executeMcp({ fixture, api, scenario, mcp });
				} finally {
					await mcp.close();
				}
			}
		: async () =>
				executeDirect({
					assembleDesignSystemKit,
					fixture,
					api,
					scenario,
					cache: scenario.cacheMode === "miss" ? new Map() : cache,
					designSystemCache:
						scenario.designSystemCacheMode === "miss"
							? new DesignSystemKitCache()
							: designSystemCache,
				});

	for (let index = 0; index < configuration.warmupRuns; index += 1)
		await execute();
	const samples = [];
	for (let index = 0; index < configuration.measuredRuns; index += 1) {
		process.stdout.write(
			`Running ${scenario.name} ${index + 1}/${configuration.measuredRuns}... `,
		);
		samples.push(await execute());
		console.log(`${samples.at(-1).wallMs.toFixed(2)} ms`);
	}

	const wallTimes = samples.map((sample) => sample.wallMs);
	const scenarioConfiguration = {
		warmupRuns: configuration.warmupRuns,
		measuredRuns: configuration.measuredRuns,
		fixtureVersion: fixture.version,
		fixtureSeed: fixture.seed,
		...scenario.args,
		cacheMode: scenario.cacheMode ?? "none",
	};
	if (scenario.designSystemCacheMode) {
		scenarioConfiguration.designSystemCacheMode = scenario.designSystemCacheMode;
	}
	return {
		name: scenario.name,
		tier: scenario.tier,
		path: scenario.mcp ? "mcp-in-memory" : "direct-assembly",
		configuration: scenarioConfiguration,
		metrics: {
			wallMs: roundedSummary(wallTimes),
			cpuMs: roundedSummary(samples.map((sample) => sample.cpuMs)),
			simulatedRestWaitMs: roundedSummary(
				samples.map((sample) => sample.restWaitMs),
			),
			simulatedRestCriticalPathMs: roundedSummary(
				samples.map((sample) => sample.restCriticalPathMs),
			),
			localProcessingMs: roundedSummary(
				samples.map((sample) => sample.localProcessingMs),
			),
			restRequestCount: roundedSummary(
				samples.map((sample) => sample.restRequestCount),
			),
			maxRestConcurrency: roundedSummary(
				samples.map((sample) => sample.maxRestConcurrency),
			),
			responseBytes: roundedSummary(
				samples.map((sample) => sample.responseBytes),
			),
			heapDeltaMb: roundedSummary(samples.map((sample) => sample.heapDeltaMb)),
			peakRssMb: roundedSummary(samples.map((sample) => sample.peakRssMb)),
			throughputOpsPerSecond: round(
				configuration.measuredRuns /
					(wallTimes.reduce((sum, value) => sum + value, 0) / 1000),
			),
		},
		samples,
	};
}

function scenarioDefinitions(tier) {
	const base = (name, include, format = "full", extra = {}) => ({
		name: `${tier.name}-${name}`,
		tier: tier.name,
		args: { include, format, includeImages: false, ...extra },
	});
	return [
		base("tokens-only", ["tokens"]),
		base("components-only", ["components"]),
		base("styles-only", ["styles"]),
		base("full-kit", ["tokens", "components", "styles"]),
		base("full-kit-with-images", ["tokens", "components", "styles"], "full", {
			includeImages: true,
		}),
		{ ...base("cache-miss", ["tokens"]), cacheMode: "miss" },
		{ ...base("cache-hit", ["tokens"]), cacheMode: "hit" },
		{
			...base("kit-cache-hit", ["tokens", "components", "styles"]),
			designSystemCacheMode: "hit",
		},
		base("full-kit-summary", ["tokens", "components", "styles"], "summary"),
		base("full-kit-compact", ["tokens", "components", "styles"], "compact"),
	];
}

function printSummary(result, outputPath) {
	console.log(
		"\n| Scenario | Path | Median | p95 | REST reqs | Max concurrency | Response bytes |",
	);
	console.log("| --- | --- | ---: | ---: | ---: | ---: | ---: |");
	for (const scenario of result.scenarios) {
		console.log(
			`| ${scenario.name} | ${scenario.path} | ${scenario.metrics.wallMs.median.toFixed(2)} ms | ${scenario.metrics.wallMs.p95.toFixed(2)} ms | ${scenario.metrics.restRequestCount.median.toFixed(0)} | ${scenario.metrics.maxRestConcurrency.median.toFixed(0)} | ${Math.round(scenario.metrics.responseBytes.median).toLocaleString()} |`,
		);
	}
	console.log(`\nResult: ${outputPath}`);
}

async function promoteResult(sourceArgument) {
	const sourcePath = resolve(REPOSITORY_ROOT, sourceArgument);
	const result = JSON.parse(await readFile(sourcePath, "utf8"));
	if (result.schemaVersion !== 1 || result.suite !== "design-system") {
		throw new Error(`${sourcePath} is not a design-system benchmark result`);
	}
	await mkdir(dirname(BASELINE_PATH), { recursive: true });
	await copyFile(sourcePath, BASELINE_PATH);
	console.log(`Promoted ${sourcePath} to ${BASELINE_PATH}`);
}

async function main() {
	const configuration = parseArguments(process.argv.slice(2));
	if (configuration.help) return printUsage();
	if (configuration.promote) return promoteResult(configuration.promote);

	const [
		{
			assembleDesignSystemKit,
			DesignSystemKitCache,
			registerDesignSystemTools,
		},
		{ McpServer },
		{ Client },
		{ InMemoryTransport },
	] = await Promise.all([
		import("../dist/core/design-system-tools.js"),
		import("@modelcontextprotocol/sdk/server/mcp.js"),
		import("@modelcontextprotocol/sdk/client/index.js"),
		import("@modelcontextprotocol/sdk/inMemory.js"),
	]);

	const tiers = [
		{ name: "small-10c-100v", components: 10, variables: 100, seed: 101 },
		{ name: "medium-100c-1000v", components: 100, variables: 1000, seed: 202 },
		{ name: "large-500c-5000v", components: 500, variables: 5000, seed: 303 },
	];
	const scenarios = [];
	for (const tier of tiers) {
		const fixture = createDesignSystemFixture(tier);
		for (const scenario of scenarioDefinitions(tier)) {
			scenarios.push(
				await runScenario({
					assembleDesignSystemKit,
					DesignSystemKitCache,
					registerDesignSystemTools,
					McpServer,
					Client,
					InMemoryTransport,
					fixture,
					configuration,
					scenario,
				}),
			);
		}
	}

	const mcpTier = {
		name: "small-10c-100v",
		components: 10,
		variables: 100,
		seed: 404,
	};
	const mcpFixture = createDesignSystemFixture(mcpTier);
	scenarios.push(
		await runScenario({
			assembleDesignSystemKit,
			DesignSystemKitCache,
			registerDesignSystemTools,
			McpServer,
			Client,
			InMemoryTransport,
			fixture: mcpFixture,
			configuration,
			scenario: {
				name: "small-mcp-end-to-end",
				tier: mcpTier.name,
				mcp: true,
				args: {
					include: ["tokens", "components", "styles"],
					format: "summary",
					includeImages: false,
				},
			},
		}),
	);

	const environment = await getEnvironment();
	const timestampDirectory = environment.timestamp.replace(/[:.]/g, "-");
	const outputPath = join(
		RESULTS_DIR,
		timestampDirectory,
		"design-system.json",
	);
	const result = {
		schemaVersion: 1,
		suite: "design-system",
		scenario: "design-system-kit-matrix",
		environment,
		configuration: {
			warmupRuns: configuration.warmupRuns,
			measuredRuns: configuration.measuredRuns,
			fixtureVersion: DESIGN_SYSTEM_FIXTURE_VERSION,
			fixtureTiers: tiers,
			latency: {
				mode: configuration.latencyMode,
				baseMs: configuration.latencyMs,
				seededJitterMs: configuration.jitterMs,
			},
			responseBytes:
				"UTF-8 bytes of the serialized kit (direct) or MCP CallToolResult (MCP path)",
			localProcessing:
				"wall time minus the union of simulated REST wait intervals; an estimate of non-I/O work",
			topLevelSectionOrdering:
				"tokens -> components -> styles; current assembly is sequential",
			percentileMethod: "linear interpolation between adjacent ranks",
			hardLimits: {
				maxRestRequestsPerScenario: MAX_REST_REQUESTS_PER_SCENARIO,
				maxCompactResponseBytes: MAX_COMPACT_RESPONSE_BYTES,
			},
		},
		scenarios,
	};
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
