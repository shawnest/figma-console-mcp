#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { arch, cpus, platform, totalmem } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { summarize } from "./stats.mjs";

const BENCHMARK_DIR = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(BENCHMARK_DIR, "..");
const SERVER_PATH = join(REPOSITORY_ROOT, "dist", "local.js");
const RESULTS_DIR = join(BENCHMARK_DIR, "results");
const BASELINE_PATH = join(BENCHMARK_DIR, "baselines", "mcp-startup.json");
const DEFAULT_WARMUP_RUNS = 1;
const DEFAULT_MEASURED_RUNS = 20;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_DIAGNOSTIC_BYTES = 32 * 1024;
// Keep enough headroom for normal catalog edits while catching accidental
// multi-hundred-kilobyte catalog growth in CI.
const MAX_CATALOG_BYTES = 200_000;

class TimedStdioClientTransport extends StdioClientTransport {
	spawnStartedAt = null;

	async start() {
		this.spawnStartedAt = performance.now();
		return super.start();
	}
}

function parsePositiveInteger(value, flag) {
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
			configuration.warmupRuns = parsePositiveInteger(
				nextArgumentValue(argv, index, argument),
				argument,
			);
			index += 1;
		} else if (argument === "--runs") {
			configuration.measuredRuns = parsePositiveInteger(
				nextArgumentValue(argv, index, argument),
				argument,
			);
			index += 1;
		} else if (argument === "--promote") {
			configuration.promote = nextArgumentValue(argv, index, argument);
			index += 1;
		} else if (argument === "--server-path") {
			configuration.serverPath = nextArgumentValue(argv, index, argument);
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
  npm run benchmark:startup
  node benchmarks/mcp-startup.mjs --warmup-runs 1 --runs 20
  node benchmarks/mcp-startup.mjs --server-path dist/local.js --runs 1
  node benchmarks/mcp-startup.mjs --promote benchmarks/results/<timestamp>/mcp-startup.json

The promotion command copies one explicitly chosen result to:
  benchmarks/baselines/mcp-startup.json`);
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
		cpu: cpus()[0]?.model ?? "unknown",
		memoryMb: Math.round(totalmem() / 1024 / 1024),
		timestamp: new Date().toISOString(),
	};
}

function sampleIdleRssMb(pid) {
	try {
		if (platform() === "win32") {
			const result = spawnSync(
				"powershell.exe",
				[
					"-NoProfile",
					"-NonInteractive",
					"-Command",
					`[Console]::Write((Get-Process -Id ${pid} -ErrorAction Stop).WorkingSet64)`,
				],
				{ encoding: "utf8", timeout: 10_000 },
			);
			if (result.status !== 0) return null;
			const bytes = Number.parseInt(result.stdout.trim(), 10);
			return Number.isFinite(bytes) ? bytes / 1024 / 1024 : null;
		}

		if (platform() === "linux") {
			const status = readFileSync(`/proc/${pid}/status`, "utf8");
			const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
			return match ? Number.parseInt(match[1], 10) / 1024 : null;
		}

		const output = execFileSync("ps", ["-o", "rss=", "-p", String(pid)], {
			encoding: "utf8",
		});
		const kilobytes = Number.parseInt(output.trim(), 10);
		return Number.isFinite(kilobytes) ? kilobytes / 1024 : null;
	} catch {
		return null;
	}
}

function appendDiagnostic(current, chunk) {
	const combined = current + chunk.toString("utf8");
	return combined.length > MAX_DIAGNOSTIC_BYTES
		? combined.slice(-MAX_DIAGNOSTIC_BYTES)
		: combined;
}

async function listAllTools(client) {
	const tools = [];
	let cursor;
	do {
		const page = await client.listTools(cursor ? { cursor } : undefined, {
			timeout: REQUEST_TIMEOUT_MS,
		});
		tools.push(...page.tools);
		cursor = page.nextCursor;
	} while (cursor);
	return tools;
}

async function runSample(runNumber, warmup, serverPath) {
	const transport = new TimedStdioClientTransport({
		command: process.execPath,
		args: [serverPath],
		cwd: REPOSITORY_ROOT,
		env: { ...process.env },
		stderr: "pipe",
	});
	const client = new Client(
		{ name: "figma-console-mcp-startup-benchmark", version: "1.0.0" },
		{ capabilities: {} },
	);
	let diagnostics = "";
	transport.stderr?.on("data", (chunk) => {
		diagnostics = appendDiagnostic(diagnostics, chunk);
	});

	try {
		await client.connect(transport, { timeout: REQUEST_TIMEOUT_MS });
		const initializedAt = performance.now();
		if (transport.spawnStartedAt === null || transport.pid === null) {
			throw new Error(
				"MCP SDK did not expose child-process timing information",
			);
		}

		const listStartedAt = performance.now();
		const tools = await listAllTools(client);
		const listCompletedAt = performance.now();
		const catalogBytes = Buffer.byteLength(JSON.stringify(tools), "utf8");
		if (catalogBytes > MAX_CATALOG_BYTES) {
			throw new Error(
				`Catalog is ${catalogBytes} bytes, above the ${MAX_CATALOG_BYTES}-byte smoke limit`,
			);
		}

		return {
			run: runNumber,
			warmup,
			initializeMs: initializedAt - transport.spawnStartedAt,
			listToolsMs: listCompletedAt - listStartedAt,
			toolCount: tools.length,
			catalogBytes,
			estimatedCatalogTokens: Math.ceil(catalogBytes / 4),
			idleRssMb: sampleIdleRssMb(transport.pid),
			idleHeapMb: null,
		};
	} catch (error) {
		const detail = diagnostics.trim();
		const context = detail
			? `\nChild stderr (tail):\n${detail}`
			: "\nChild produced no stderr.";
		throw new Error(
			`MCP startup sample ${runNumber}${warmup ? " (warm-up)" : ""} failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}${context}`,
			{ cause: error },
		);
	} finally {
		try {
			await client.close();
		} catch {
			await transport.close().catch(() => {});
		}
	}
}

function round(value, digits = 3) {
	return value === null ? null : Number(value.toFixed(digits));
}

function roundedSummary(values) {
	const stats = summarize(values);
	return Object.fromEntries(
		Object.entries(stats).map(([key, value]) => [key, round(value, 4)]),
	);
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

function printSummary(result, outputPath) {
	const metrics = result.metrics;
	console.log("\n| Metric | Median | p95 |");
	console.log("| --- | ---: | ---: |");
	console.log(
		`| Spawn → initialize | ${metrics.initializeMs.median.toFixed(2)} ms | ${metrics.initializeMs.p95.toFixed(2)} ms |`,
	);
	console.log(
		`| tools/list | ${metrics.listToolsMs.median.toFixed(2)} ms | ${metrics.listToolsMs.p95.toFixed(2)} ms |`,
	);
	if (metrics.idleRssMb) {
		console.log(
			`| Child idle RSS | ${metrics.idleRssMb.median.toFixed(2)} MiB | ${metrics.idleRssMb.p95.toFixed(2)} MiB |`,
		);
	}
	console.log(`\nTools: ${metrics.toolCount}`);
	console.log(`Catalog: ${metrics.catalogBytes.toLocaleString()} bytes`);
	console.log(
		`Estimated catalog tokens: ${metrics.estimatedCatalogTokens.toLocaleString()} (bytes ÷ 4)`,
	);
	console.log(`Result: ${outputPath}`);
}

async function promoteResult(sourceArgument) {
	if (!sourceArgument) throw new Error("--promote requires a result JSON path");
	const sourcePath = resolve(REPOSITORY_ROOT, sourceArgument);
	const result = JSON.parse(await readFile(sourcePath, "utf8"));
	if (result.schemaVersion !== 1 || result.suite !== "mcp-startup") {
		throw new Error(`${sourcePath} is not an MCP startup benchmark result`);
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

	console.log(
		`MCP startup benchmark: ${configuration.warmupRuns} warm-up, ${configuration.measuredRuns} measured runs`,
	);
	const serverPath = configuration.serverPath
		? resolve(REPOSITORY_ROOT, configuration.serverPath)
		: SERVER_PATH;
	const totalRuns = configuration.warmupRuns + configuration.measuredRuns;
	const samples = [];
	for (let index = 0; index < totalRuns; index += 1) {
		const warmup = index < configuration.warmupRuns;
		const runNumber = warmup ? index + 1 : index - configuration.warmupRuns + 1;
		process.stdout.write(
			`${warmup ? "Warm-up" : "Measured"} ${runNumber}/${warmup ? configuration.warmupRuns : configuration.measuredRuns}... `,
		);
		const sample = await runSample(runNumber, warmup, serverPath);
		console.log(`${sample.initializeMs.toFixed(2)} ms ready`);
		if (!warmup) samples.push(sample);
	}

	const rssSamples = samples
		.map((sample) => sample.idleRssMb)
		.filter((value) => value !== null);
	const environment = await getEnvironment();
	const timestampDirectory = environment.timestamp.replace(/[:.]/g, "-");
	const outputPath = join(RESULTS_DIR, timestampDirectory, "mcp-startup.json");
	const result = {
		schemaVersion: 1,
		suite: "mcp-startup",
		scenario: "initialize-and-list-tools",
		environment,
		configuration: {
			warmupRuns: configuration.warmupRuns,
			measuredRuns: configuration.measuredRuns,
			serverPath: relative(REPOSITORY_ROOT, serverPath).replaceAll("\\", "/"),
			requestTimeoutMs: REQUEST_TIMEOUT_MS,
			hardLimits: {
				maxCatalogBytes: MAX_CATALOG_BYTES,
			},
			catalogSerialization: "UTF-8 byte length of JSON.stringify(tools)",
			estimatedCatalogTokens:
				"ceil(catalogBytes / 4); estimate only, not tokenizer output",
			percentileMethod: "linear interpolation between adjacent ranks",
		},
		metrics: {
			initializeMs: roundedSummary(
				samples.map((sample) => sample.initializeMs),
			),
			listToolsMs: roundedSummary(samples.map((sample) => sample.listToolsMs)),
			toolCount: invariantValue(samples, "toolCount"),
			catalogBytes: invariantValue(samples, "catalogBytes"),
			estimatedCatalogTokens: invariantValue(samples, "estimatedCatalogTokens"),
			idleRssMb:
				rssSamples.length === samples.length
					? roundedSummary(rssSamples)
					: null,
			idleHeapMb: null,
		},
		availability: {
			idleRssMb:
				rssSamples.length === samples.length
					? "available"
					: "unavailable: operating-system process RSS query failed",
			idleHeapMb:
				"unavailable: a standard MCP stdio child does not expose V8 heap statistics without intrusive instrumentation",
		},
		samples: samples.map((sample) => ({
			...sample,
			initializeMs: round(sample.initializeMs),
			listToolsMs: round(sample.listToolsMs),
			idleRssMb: round(sample.idleRssMb),
		})),
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
