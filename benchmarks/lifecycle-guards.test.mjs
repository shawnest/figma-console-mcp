import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { WebSocket } from "ws";
import { FigmaWebSocketServer } from "../dist/core/websocket-server.js";
import {
	assertNoPendingRequests,
	getPendingRequestCount,
	inspectServerCleanup,
} from "./lifecycle-guards.mjs";

const CLEANUP_TIMEOUT_MS = 2_000;
const FILE_KEY = "lifecycle-guard-test-file";

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

function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, label) {
	const deadline = Date.now() + CLEANUP_TIMEOUT_MS;
	while (!predicate()) {
		if (Date.now() >= deadline) {
			throw new Error(`${label} did not reach the expected state`);
		}
		await delay(5);
	}
}

async function openSocket(server) {
	const port = server.address()?.port;
	assert.ok(port, "server did not expose a bound port");
	const socket = new WebSocket(`ws://127.0.0.1:${port}`);
	await withTimeout(once(socket, "open"), CLEANUP_TIMEOUT_MS, "socket open");
	return socket;
}

async function openIdentifiedSocket(server) {
	const connected = once(server, "connected");
	const socket = await openSocket(server);
	socket.send(
		JSON.stringify({
			type: "FILE_INFO",
			data: {
				fileKey: FILE_KEY,
				fileName: "Lifecycle Guard Test File",
				currentPage: "Lifecycle Guard Test Page",
				pluginVersion: "lifecycle-guard-test",
			},
		}),
	);
	await withTimeout(connected, CLEANUP_TIMEOUT_MS, "FILE_INFO handshake");
	return socket;
}

async function closeSocket(socket) {
	if (!socket || socket.readyState === WebSocket.CLOSED) return;
	const closed = once(socket, "close");
	socket.terminate();
	await withTimeout(closed, CLEANUP_TIMEOUT_MS, "socket close");
}

test("lifecycle guard rejects an unresolved pending request", async () => {
	const server = new FigmaWebSocketServer({ port: 0, host: "127.0.0.1" });
	let socket;
	let pending;
	try {
		await server.start();
		socket = await openIdentifiedSocket(server);
		pending = server.sendCommand(
			"LIFECYCLE_PENDING_REQUEST_LEAK",
			{ benchmarkId: "lifecycle-guard:pending-request" },
			CLEANUP_TIMEOUT_MS,
			FILE_KEY,
		);
		// Keep the intentionally rejected promise handled while the guard runs.
		void pending.catch(() => {});

		assert.equal(getPendingRequestCount(server), 1);
		assert.throws(
			() => assertNoPendingRequests(server, "Intentional pending-request leak"),
			/retained 1 pending request/,
		);
	} finally {
		await server.stop().catch(() => {});
		await closeSocket(socket).catch(() => {});
	}

	assert.ok(pending, "pending request was not created");
	await assert.rejects(pending, /shutting down|closed|timed out/i);
	assert.equal(getPendingRequestCount(server), 0);
});

test("lifecycle guard rejects an unclosed WebSocket", async () => {
	const server = new FigmaWebSocketServer({ port: 0, host: "127.0.0.1" });
	let socket;
	try {
		await server.start();
		socket = await openSocket(server);
		await waitFor(
			() => server._pendingClients?.size === 1,
			"unidentified socket registration",
		);

		assert.throws(
			() => inspectServerCleanup(server),
			(error) =>
				error instanceof Error &&
				error.message.includes('"pendingClients":1'),
		);
	} finally {
		await closeSocket(socket).catch(() => {});
		await server.stop().catch(() => {});
	}

	assert.doesNotThrow(() => inspectServerCleanup(server));
});
