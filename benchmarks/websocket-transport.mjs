#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer as createTcpServer } from "node:net";
import { arch, cpus, platform, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import {
	createVariablesResponseFixture,
	VARIABLES_FIXTURE_VERSION,
} from "./fixtures/variables-response.mjs";
import {
	assertNoPendingRequests,
	captureActiveHandles,
	getPendingRequestCount,
	inspectActiveHandleDelta,
	inspectServerCleanup,
} from "./lifecycle-guards.mjs";
import { summarize } from "./stats.mjs";

process.env.LOG_LEVEL ??= "error";

const BENCHMARK_DIR = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(BENCHMARK_DIR, "..");
const RESULTS_DIR = join(BENCHMARK_DIR, "results");
const BASELINE_PATH = join(
	BENCHMARK_DIR,
	"baselines",
	"websocket-transport.json",
);
const DEFAULT_WARMUP_RUNS = 1;
const DEFAULT_MEASURED_RUNS = 20;
const COMMAND_TIMEOUT_MS = 15_000;
const CLEANUP_TIMEOUT_MS = 10_000;
const NO_RESPONSE = Symbol("no-response");

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
  npm run benchmark:transport
  node --expose-gc benchmarks/websocket-transport.mjs --warmup-runs 0 --runs 5
  node benchmarks/websocket-transport.mjs --promote benchmarks/results/<timestamp>/websocket-transport.json

The promotion command copies one explicitly chosen result to:
  benchmarks/baselines/websocket-transport.json`);
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

function toMb(bytes) {
	return bytes / 1024 / 1024;
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

function withTimeout(promise, timeoutMs, label) {
	let timeoutId;
	const timeout = new Promise((_, reject) => {
		timeoutId = setTimeout(
			() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
			timeoutMs,
		);
	});
	return Promise.race([promise, timeout]).finally(() =>
		clearTimeout(timeoutId),
	);
}

class MockPlugin {
	constructor(url) {
		this.url = url;
		this.socket = null;
		this.responder = null;
		this.wireBytes = new Map();
	}

	async connect(server) {
		const connected = new Promise((resolveConnected) =>
			server.once("connected", resolveConnected),
		);
		this.socket = new WebSocket(this.url);
		this.socket.on("message", (data) => this.handleMessage(data));
		await withTimeout(
			new Promise((resolveOpen, rejectOpen) => {
				this.socket.once("open", resolveOpen);
				this.socket.once("error", rejectOpen);
			}),
			CLEANUP_TIMEOUT_MS,
			"mock plugin connection",
		);
		this.socket.send(
			JSON.stringify({
				type: "FILE_INFO",
				data: {
					fileKey: "benchmark-file-key",
					fileName: "Synthetic Benchmark File",
					currentPage: "Benchmark Page",
					pluginVersion: "benchmark",
				},
			}),
		);
		await withTimeout(connected, CLEANUP_TIMEOUT_MS, "FILE_INFO handshake");
	}

	setResponder(responder) {
		this.responder = responder;
	}

	handleMessage(data) {
		const requestText = data.toString();
		const message = JSON.parse(requestText);
		if (!message.id || !message.method) return;
		if (!this.responder)
			throw new Error("Mock plugin received a command without a responder");

		const responseResult = this.responder(message, this);
		if (responseResult === NO_RESPONSE) return;
		const responseText = JSON.stringify({
			id: message.id,
			result: responseResult,
		});
		const benchmarkId = message.params?.benchmarkId;
		if (benchmarkId) {
			this.wireBytes.set(benchmarkId, {
				requestBytes: Buffer.byteLength(requestText, "utf8"),
				responseBytes: Buffer.byteLength(responseText, "utf8"),
			});
		}
		this.socket.send(responseText);
	}

	takeWireBytes(benchmarkId) {
		const value = this.wireBytes.get(benchmarkId);
		this.wireBytes.delete(benchmarkId);
		if (!value) throw new Error(`Missing wire-byte record for ${benchmarkId}`);
		return value;
	}

	terminate() {
		this.socket?.terminate();
	}

	async close() {
		const socket = this.socket;
		if (!socket || socket.readyState === WebSocket.CLOSED) return;
		const closed = new Promise((resolveClosed) =>
			socket.once("close", resolveClosed),
		);
		if (socket.readyState === WebSocket.OPEN) socket.close();
		else socket.terminate();
		await withTimeout(closed, CLEANUP_TIMEOUT_MS, "mock plugin close");
	}
}

function createExactSizeResponse(message, targetBytes) {
	const baseResult = { benchmarkId: message.params.benchmarkId, payload: "" };
	const baseBytes = Buffer.byteLength(
		JSON.stringify({ id: message.id, result: baseResult }),
		"utf8",
	);
	if (baseBytes > targetBytes) {
		throw new Error(
			`Response envelope (${baseBytes} bytes) exceeds target ${targetBytes}`,
		);
	}
	return {
		benchmarkId: message.params.benchmarkId,
		payload: "x".repeat(targetBytes - baseBytes),
	};
}

function peakMemorySampler() {
	let peakRss = process.memoryUsage().rss;
	return {
		sample() {
			peakRss = Math.max(peakRss, process.memoryUsage().rss);
		},
		get peakRss() {
			return peakRss;
		},
	};
}

async function runBounded(operationCount, concurrency, operation) {
	let nextIndex = 0;
	const samples = new Array(operationCount);
	async function worker() {
		while (nextIndex < operationCount) {
			const index = nextIndex;
			nextIndex += 1;
			samples[index] = await operation(index);
		}
	}
	await Promise.all(
		Array.from({ length: Math.min(concurrency, operationCount) }, () =>
			worker(),
		),
	);
	return samples;
}

async function runScenario({
	server,
	plugin,
	name,
	concurrency,
	measuredRuns,
	warmupRuns,
	responder,
	validate,
	configuration = {},
}) {
	plugin.setResponder(responder);
	let sequence = 0;

	async function execute(record, memorySampler) {
		const currentSequence = sequence;
		sequence += 1;
		const benchmarkId = `${name}:${currentSequence}`;
		const startedAt = performance.now();
		const result = await server.sendCommand(
			"BENCHMARK_TRANSPORT",
			{ benchmarkId, sequence: currentSequence },
			COMMAND_TIMEOUT_MS,
			"benchmark-file-key",
		);
		const completedAt = performance.now();
		validate(result, currentSequence, benchmarkId);
		memorySampler?.sample();
		const wire = plugin.takeWireBytes(benchmarkId);
		if (!record) return null;
		return {
			iteration: currentSequence,
			roundTripMs: round(completedAt - startedAt),
			requestBytes: wire.requestBytes,
			responseBytes: wire.responseBytes,
			serializedBytes: wire.requestBytes + wire.responseBytes,
		};
	}

	for (let index = 0; index < warmupRuns; index += 1) {
		await execute(false);
	}
	globalThis.gc?.();
	const memoryBefore = process.memoryUsage();
	const memorySampler = peakMemorySampler();
	const cpuBefore = process.cpuUsage();
	const wallStartedAt = performance.now();
	const samples = await runBounded(measuredRuns, concurrency, (index) =>
		execute(true, memorySampler, index),
	);
	const wallMs = performance.now() - wallStartedAt;
	const cpu = process.cpuUsage(cpuBefore);
	globalThis.gc?.();
	const memoryAfter = process.memoryUsage();

	if (samples.length !== measuredRuns || samples.some((sample) => !sample)) {
		throw new Error(`${name} completed with missing samples`);
	}
	const roundTrips = samples.map((sample) => sample.roundTripMs);
	const requestBytes = samples.map((sample) => sample.requestBytes);
	const responseBytes = samples.map((sample) => sample.responseBytes);
	const serializedBytes = samples.map((sample) => sample.serializedBytes);

	return {
		name,
		configuration: {
			warmupRuns,
			measuredRuns,
			concurrency,
			...configuration,
		},
		metrics: {
			roundTripMs: roundedSummary(roundTrips),
			throughputOpsPerSecond: round(measuredRuns / (wallMs / 1000)),
			wallMs: round(wallMs),
			cpuMs: round((cpu.user + cpu.system) / 1000),
			requestBytes: roundedSummary(requestBytes),
			responseBytes: roundedSummary(responseBytes),
			serializedBytes: roundedSummary(serializedBytes),
			heapDeltaMb: round(toMb(memoryAfter.heapUsed - memoryBefore.heapUsed)),
			peakRssMb: round(toMb(memorySampler.peakRss)),
		},
		samples,
	};
}

async function runLifecycleChecks(server, plugin, websocketUrl) {
	plugin.setResponder(() => NO_RESPONSE);
	const timeoutStartedAt = performance.now();
	await server
		.sendCommand(
			"BENCHMARK_TIMEOUT",
			{ benchmarkId: "lifecycle:timeout" },
			50,
			"benchmark-file-key",
		)
		.then(() => {
			throw new Error("Timeout lifecycle check unexpectedly resolved");
		})
		.catch((error) => {
			if (!String(error).includes("timed out")) throw error;
		});
	const timeoutMs = performance.now() - timeoutStartedAt;
	assertNoPendingRequests(server, "Timed-out command");

	plugin.setResponder((_message, currentPlugin) => {
		currentPlugin.terminate();
		return NO_RESPONSE;
	});
	const disconnectStartedAt = performance.now();
	await server
		.sendCommand(
			"BENCHMARK_DISCONNECT",
			{ benchmarkId: "lifecycle:disconnect" },
			COMMAND_TIMEOUT_MS,
			"benchmark-file-key",
		)
		.then(() => {
			throw new Error("Disconnect lifecycle check unexpectedly resolved");
		})
		.catch((error) => {
			if (!String(error).match(/disconnect|closed|replaced/i)) throw error;
		});
	const disconnectMs = performance.now() - disconnectStartedAt;
	assertNoPendingRequests(server, "Disconnected command");

	await plugin.close();
	const replacementPlugin = new MockPlugin(websocketUrl);
	await replacementPlugin.connect(server);
	replacementPlugin.setResponder((message) => ({
		benchmarkId: message.params.benchmarkId,
		sequence: message.params.sequence,
	}));
	const recoveryId = "lifecycle:recovery";
	const recovery = await server.sendCommand(
		"BENCHMARK_RECOVERY",
		{ benchmarkId: recoveryId, sequence: 1 },
		COMMAND_TIMEOUT_MS,
		"benchmark-file-key",
	);
	if (recovery.benchmarkId !== recoveryId || recovery.sequence !== 1) {
		throw new Error("Bridge did not recover after disconnect cleanup");
	}
	replacementPlugin.takeWireBytes(recoveryId);

	return {
		timeoutRejected: true,
		timeoutCleanupMs: round(timeoutMs),
		disconnectRejected: true,
		disconnectCleanupMs: round(disconnectMs),
		pendingRequestsAfterChecks: getPendingRequestCount(server),
		recoveryRequestSucceeded: true,
		replacementPlugin,
	};
}

async function assertPortReleased(port) {
	const probe = createTcpServer();
	await withTimeout(
		new Promise((resolveListening, rejectListening) => {
			probe.once("error", rejectListening);
			probe.listen(port, "127.0.0.1", resolveListening);
		}),
		CLEANUP_TIMEOUT_MS,
		"port-release probe",
	);
	await new Promise((resolveClosed, rejectClosed) => {
		probe.close((error) => (error ? rejectClosed(error) : resolveClosed()));
	});
}

function printSummary(result, outputPath) {
	console.log(
		"\n| Scenario | Ops | Concurrency | Median | p95 | p99 | Ops/s | Response bytes |",
	);
	console.log("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
	for (const scenario of result.scenarios) {
		console.log(
			`| ${scenario.name} | ${scenario.configuration.measuredRuns} | ${scenario.configuration.concurrency} | ${scenario.metrics.roundTripMs.median.toFixed(2)} ms | ${scenario.metrics.roundTripMs.p95.toFixed(2)} ms | ${scenario.metrics.roundTripMs.p99.toFixed(2)} ms | ${scenario.metrics.throughputOpsPerSecond.toFixed(1)} | ${Math.round(scenario.metrics.responseBytes.median).toLocaleString()} |`,
		);
	}
	console.log(`\nResult: ${outputPath}`);
}

async function promoteResult(sourceArgument) {
	const sourcePath = resolve(REPOSITORY_ROOT, sourceArgument);
	const result = JSON.parse(await readFile(sourcePath, "utf8"));
	if (result.schemaVersion !== 1 || result.suite !== "websocket-transport") {
		throw new Error(
			`${sourcePath} is not a WebSocket transport benchmark result`,
		);
	}
	await mkdir(dirname(BASELINE_PATH), { recursive: true });
	await copyFile(sourcePath, BASELINE_PATH);
	console.log(`Promoted ${sourcePath} to ${BASELINE_PATH}`);
}

async function main() {
	const commandLine = parseArguments(process.argv.slice(2));
	if (commandLine.help) {
		printUsage();
		return;
	}
	if (commandLine.promote) {
		await promoteResult(commandLine.promote);
		return;
	}

	const { FigmaWebSocketServer } = await import(
		"../dist/core/websocket-server.js"
	);
	const baselineHandles = captureActiveHandles();
	const server = new FigmaWebSocketServer({ port: 0, host: "127.0.0.1" });
	let plugin;
	let replacementPlugin;
	let boundPort;
	const scenarios = [];

	try {
		await server.start();
		const address = server.address();
		if (!address?.port)
			throw new Error("Bridge did not report an OS-assigned port");
		boundPort = address.port;
		const websocketUrl = `ws://127.0.0.1:${boundPort}`;
		plugin = new MockPlugin(websocketUrl);
		await plugin.connect(server);

		const tinyResponder = (message) => ({
			benchmarkId: message.params.benchmarkId,
			sequence: message.params.sequence,
			ok: true,
		});
		const tinyValidator = (result, sequence, benchmarkId) => {
			if (
				result.benchmarkId !== benchmarkId ||
				result.sequence !== sequence ||
				result.ok !== true
			) {
				throw new Error("Tiny response correlation or content was incorrect");
			}
		};
		for (const concurrency of [1, 2, 8, 32]) {
			const measuredRuns = Math.max(commandLine.measuredRuns, concurrency * 4);
			const name =
				concurrency === 1
					? "tiny-sequential"
					: `tiny-concurrency-${concurrency}`;
			process.stdout.write(`Running ${name}... `);
			const scenario = await runScenario({
				server,
				plugin,
				name,
				concurrency,
				measuredRuns,
				warmupRuns: commandLine.warmupRuns,
				responder: tinyResponder,
				validate: tinyValidator,
			});
			scenarios.push(scenario);
			console.log(
				`${scenario.metrics.roundTripMs.median.toFixed(2)} ms median`,
			);
		}

		for (const targetBytes of [100 * 1024, 1024 * 1024, 10 * 1024 * 1024]) {
			const sizeLabel =
				targetBytes === 100 * 1024
					? "100kb"
					: targetBytes === 1024 * 1024
						? "1mb"
						: "10mb";
			const name = `json-response-${sizeLabel}`;
			process.stdout.write(`Running ${name}... `);
			const scenario = await runScenario({
				server,
				plugin,
				name,
				concurrency: 1,
				measuredRuns: commandLine.measuredRuns,
				warmupRuns: commandLine.warmupRuns,
				responder: (message) => createExactSizeResponse(message, targetBytes),
				validate: (result, _sequence, benchmarkId) => {
					if (
						result.benchmarkId !== benchmarkId ||
						!result.payload ||
						result.payload.at(-1) !== "x"
					) {
						throw new Error(`${name} response was corrupted`);
					}
				},
				configuration: { targetResponseBytes: targetBytes },
			});
			if (
				scenario.samples.some((sample) => sample.responseBytes !== targetBytes)
			) {
				throw new Error(
					`${name} did not produce exact ${targetBytes}-byte responses`,
				);
			}
			scenarios.push(scenario);
			console.log(
				`${scenario.metrics.roundTripMs.median.toFixed(2)} ms median`,
			);
		}

		const variablesFixture = createVariablesResponseFixture();
		const variablesFixtureBytes = Buffer.byteLength(
			JSON.stringify(variablesFixture),
			"utf8",
		);
		process.stdout.write("Running variables-response... ");
		const variablesScenario = await runScenario({
			server,
			plugin,
			name: "variables-response",
			concurrency: 1,
			measuredRuns: commandLine.measuredRuns,
			warmupRuns: commandLine.warmupRuns,
			responder: (message) => ({
				benchmarkId: message.params.benchmarkId,
				...variablesFixture,
			}),
			validate: (result, _sequence, benchmarkId) => {
				if (
					result.benchmarkId !== benchmarkId ||
					result.variables?.length !== 120 ||
					result.variableCollections?.length !== 3 ||
					!result.variables.some(
						(variable) => variable.valuesByMode && variable.codeSyntax,
					)
				) {
					throw new Error("Representative variables response was corrupted");
				}
			},
			configuration: {
				fixtureVersion: VARIABLES_FIXTURE_VERSION,
				fixtureBytes: variablesFixtureBytes,
				variableCount: variablesFixture.variables.length,
				collectionCount: variablesFixture.variableCollections.length,
			},
		});
		scenarios.push(variablesScenario);
		console.log(
			`${variablesScenario.metrics.roundTripMs.median.toFixed(2)} ms median`,
		);

		process.stdout.write("Running lifecycle checks... ");
		const lifecycle = await runLifecycleChecks(server, plugin, websocketUrl);
		replacementPlugin = lifecycle.replacementPlugin;
		delete lifecycle.replacementPlugin;
		console.log("passed");

		await replacementPlugin.close();
		await server.stop();
		await delay(25);
		const shutdownState = inspectServerCleanup(server);
		const activeHandleCheck = inspectActiveHandleDelta(baselineHandles);
		await assertPortReleased(boundPort);

		const environment = await getEnvironment();
		const timestampDirectory = environment.timestamp.replace(/[:.]/g, "-");
		const outputPath = join(
			RESULTS_DIR,
			timestampDirectory,
			"websocket-transport.json",
		);
		const result = {
			schemaVersion: 1,
			suite: "websocket-transport",
			scenario: "transport-matrix",
			environment,
			configuration: {
				warmupRuns: commandLine.warmupRuns,
				minimumMeasuredRuns: commandLine.measuredRuns,
				commandTimeoutMs: COMMAND_TIMEOUT_MS,
				portSelection: "OS-assigned",
				memoryScope:
					"benchmark process containing real bridge server and mock plugin",
				serializedByteDefinition:
					"UTF-8 bytes of JSON request and response payloads; excludes WebSocket frame overhead",
				garbageCollection: globalThis.gc
					? "explicit between scenarios"
					: "runtime managed",
				percentileMethod: "linear interpolation between adjacent ranks",
				hardLimits: {
					noUnresolvedPendingRequests: true,
					cleanServerAndSocketShutdown: true,
				},
			},
			scenarios,
			lifecycle: {
				...lifecycle,
				shutdownState,
				portReleasedAfterShutdown: true,
				activeHandleCheck,
			},
			correctness: {
				noUnresolvedPendingRequests:
					lifecycle.pendingRequestsAfterChecks === 0 &&
					shutdownState.pendingRequests === 0,
				cleanServerAndSocketShutdown:
					!shutdownState.started &&
					shutdownState.identifiedClients === 0 &&
					shutdownState.pendingClients === 0 &&
					!shutdownState.heartbeatActive &&
					!shutdownState.httpServerActive &&
					(activeHandleCheck.unexpectedCount === 0 ||
						!activeHandleCheck.available),
				portReleased: true,
			},
		};
		await mkdir(dirname(outputPath), { recursive: true });
		await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
		printSummary(result, outputPath);
	} finally {
		await replacementPlugin?.close().catch(() => {});
		await plugin?.close().catch(() => {});
		await server.stop().catch(() => {});
	}
}

main().catch((error) => {
	console.error(
		error instanceof Error ? (error.stack ?? error.message) : error,
	);
	process.exitCode = 1;
});
