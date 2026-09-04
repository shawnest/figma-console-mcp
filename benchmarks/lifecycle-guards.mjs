export function captureActiveHandles() {
	if (typeof process._getActiveHandles !== "function") return null;
	return new Set(process._getActiveHandles());
}

export function inspectActiveHandleDelta(baselineHandles) {
	if (!baselineHandles || typeof process._getActiveHandles !== "function") {
		return { available: false, unexpectedCount: null, unexpectedTypes: [] };
	}
	const unexpectedHandles = process
		._getActiveHandles()
		.filter((handle) => !baselineHandles.has(handle));
	const unexpectedTypes = unexpectedHandles.map(
		(handle) => handle.constructor?.name ?? "UnknownHandle",
	);
	if (unexpectedHandles.length > 0) {
		throw new Error(
			`Benchmark retained active handles after shutdown: ${unexpectedTypes.join(", ")}`,
		);
	}
	return { available: true, unexpectedCount: 0, unexpectedTypes };
}

export function getPendingRequestCount(server) {
	const pendingRequests = server.pendingRequests;
	if (!(pendingRequests instanceof Map)) {
		throw new Error("Unable to inspect bridge pending-request state");
	}
	return pendingRequests.size;
}

export function assertNoPendingRequests(server, label = "Bridge") {
	const pendingCount = getPendingRequestCount(server);
	if (pendingCount !== 0) {
		throw new Error(
			`${label} retained ${pendingCount} pending request${pendingCount === 1 ? "" : "s"}`,
		);
	}
}

export function inspectServerCleanup(server) {
	const checks = {
		started: server.isStarted(),
		pendingRequests: server.pendingRequests?.size,
		identifiedClients: server.clients?.size,
		pendingClients: server._pendingClients?.size,
		heartbeatActive: server._heartbeatInterval !== null,
		httpServerActive: server.httpServer !== null,
	};
	if (
		checks.started ||
		checks.pendingRequests !== 0 ||
		checks.identifiedClients !== 0 ||
		checks.pendingClients !== 0 ||
		checks.heartbeatActive ||
		checks.httpServerActive
	) {
		throw new Error(
			`WebSocket server retained resources: ${JSON.stringify(checks)}`,
		);
	}
	return checks;
}
