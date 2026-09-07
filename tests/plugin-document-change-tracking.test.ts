/**
 * PERF-02 regression coverage for deferred all-page loading.
 *
 * The plugin files run in Figma's sandbox and are intentionally plain JS, so
 * these tests execute the isolated tracking helper in a VM with a fake Figma
 * plugin API. Source-level assertions cover the startup and UI wiring that
 * cannot be exercised without Figma Desktop.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as vm from "node:vm";

const pluginDir = join(__dirname, "..", "figma-desktop-bridge");
const codeSource = readFileSync(join(pluginDir, "code.js"), "utf8");
const uiSource = readFileSync(join(pluginDir, "ui.html"), "utf8");

const helperStart = codeSource.indexOf("var __allPagesLoaded = false;");
const helperEnd = codeSource.indexOf(
	"\n// Helper to extract a component's SLOT contract",
	helperStart,
);

if (helperStart < 0 || helperEnd < 0) {
	throw new Error("Could not locate the PERF-02 document-change tracking helper");
}

const helperSource = codeSource.slice(helperStart, helperEnd);

function createSandbox() {
	const listeners: Record<string, Function[]> = {
		documentchange: [],
		selectionchange: [],
		currentpagechange: [],
	};
	let loadAllPagesCalls = 0;
	let loadAllPagesShouldFail = false;
	const postMessage = jest.fn();
	const currentPage = {
		id: "0:1",
		name: "Page 1",
		selection: [
			{ id: "1:1", name: "Button", type: "FRAME", width: 120, height: 40 },
		],
	};

	const sandbox: Record<string, any> = {
		figma: {
			currentPage,
			ui: { postMessage },
			on(event: string, handler: Function) {
				if (!listeners[event]) listeners[event] = [];
				listeners[event].push(handler);
			},
			loadAllPagesAsync: jest.fn(async () => {
				loadAllPagesCalls += 1;
				if (loadAllPagesShouldFail) {
					throw new Error("temporary Plugin API failure");
				}
			}),
		},
		__benchmarkClock: () => 0,
		__benchmarkRecord: () => {},
		console,
		Date,
		Math,
		Array,
		Object,
		JSON,
		Promise,
		setTimeout,
		clearTimeout,
	};

	vm.runInNewContext(helperSource, sandbox);

	return {
		sandbox,
		postMessage,
		listeners,
		currentPage,
		get loadAllPagesCalls() {
			return loadAllPagesCalls;
		},
		failNextLoad() {
			loadAllPagesShouldFail = true;
		},
		succeedLoads() {
			loadAllPagesShouldFail = false;
		},
	};
}

describe("PERF-02 deferred all-page loading", () => {
	it("does not load all pages or register documentchange during startup", () => {
		const tail = codeSource.slice(
			codeSource.indexOf(
				"// Lightweight listeners are valid immediately",
			),
		);

		expect(tail).toContain("__registerSelectionAndPageListeners()");
		expect(tail).not.toContain("figma.loadAllPagesAsync()");
		expect(tail).not.toContain("figma.on('documentchange'");
	});

	it("registers selection and page listeners without loading pages", () => {
		const bridge = createSandbox();
		bridge.sandbox.__registerSelectionAndPageListeners();
		bridge.sandbox.__registerSelectionAndPageListeners();

		expect(bridge.loadAllPagesCalls).toBe(0);
		expect(bridge.listeners.selectionchange).toHaveLength(1);
		expect(bridge.listeners.currentpagechange).toHaveLength(1);
		expect(bridge.listeners.documentchange).toHaveLength(0);

		bridge.listeners.selectionchange[0]();
		expect(bridge.postMessage).toHaveBeenCalledWith({
			type: "SELECTION_CHANGE",
			data: {
				nodes: [
					{
						id: "1:1",
						name: "Button",
						type: "FRAME",
						width: 120,
						height: 40,
					},
				],
				count: 1,
				page: "Page 1",
				timestamp: expect.any(Number),
			},
		});

		bridge.listeners.currentpagechange[0]();
		expect(bridge.postMessage).toHaveBeenCalledWith({
			type: "PAGE_CHANGE",
			data: {
				pageId: "0:1",
				pageName: "Page 1",
				timestamp: expect.any(Number),
			},
		});
	});

	it("shares concurrent activations and does not add duplicate listeners", async () => {
		const bridge = createSandbox();
		bridge.sandbox.__registerSelectionAndPageListeners();

		const first = bridge.sandbox.__ensureDocumentChangeTracking("request-1");
		const second = bridge.sandbox.__ensureDocumentChangeTracking("request-2");
		expect(first).toBe(second);

		const result = await first;
		expect(result.activated).toBe(true);
		expect(result.alreadyActive).toBe(false);
		expect(bridge.loadAllPagesCalls).toBe(1);
		expect(bridge.listeners.documentchange).toHaveLength(1);

		const repeat = await bridge.sandbox.__ensureDocumentChangeTracking(
			"request-3",
		);
		expect(repeat.alreadyActive).toBe(true);
		expect(bridge.loadAllPagesCalls).toBe(1);
		expect(bridge.listeners.documentchange).toHaveLength(1);
		expect(bridge.listeners.selectionchange).toHaveLength(1);
	});

	it("retries after a failed first load without disabling selection tracking", async () => {
		const bridge = createSandbox();
		bridge.sandbox.__registerSelectionAndPageListeners();
		bridge.failNextLoad();

		await expect(
			bridge.sandbox.__ensureDocumentChangeTracking("failed"),
		).rejects.toThrow("temporary Plugin API failure");
		expect(bridge.listeners.selectionchange).toHaveLength(1);
		expect(bridge.listeners.documentchange).toHaveLength(0);

		bridge.succeedLoads();
		const recovered = await bridge.sandbox.__ensureDocumentChangeTracking(
			"retry",
		);
		expect(recovered.activated).toBe(true);
		expect(bridge.loadAllPagesCalls).toBe(2);
		expect(bridge.listeners.documentchange).toHaveLength(1);
	});

	it("shares a successful page load between component traversal and change tracking", async () => {
		const bridge = createSandbox();
		await bridge.sandbox.__loadAllPagesAsync("components", "GET_LOCAL_COMPONENTS");
		const tracking = await bridge.sandbox.__ensureDocumentChangeTracking(
			"activate",
		);

		expect(tracking.activated).toBe(true);
		expect(bridge.loadAllPagesCalls).toBe(1);
		expect(bridge.listeners.documentchange).toHaveLength(1);
	});

	it("forwards node, style, and metadata changes after activation", async () => {
		const bridge = createSandbox();
		await bridge.sandbox.__ensureDocumentChangeTracking("activate");

		bridge.listeners.documentchange[0]({
			documentChanges: [
				{
					type: "PROPERTY_CHANGE",
					id: "2:2",
					node: {
						id: "2:2",
						name: "Card",
						type: "COMPONENT",
						description: "Updated",
					},
					properties: ["description"],
				},
				{ type: "STYLE_PROPERTY_CHANGE" },
			],
		});

		expect(bridge.postMessage).toHaveBeenCalledWith({
			type: "METADATA_CHANGE",
			data: {
				changes: [
					expect.objectContaining({
						node_id: "2:2",
						field: "description",
						new_value: "Updated",
					}),
				],
			},
		});
		expect(bridge.postMessage).toHaveBeenCalledWith({
			type: "DOCUMENT_CHANGE",
			data: expect.objectContaining({
				hasStyleChanges: true,
				hasNodeChanges: true,
				changedNodeIds: ["2:2"],
				changeCount: 2,
			}),
		});
	});

	it("activates from the first local or cloud connection and shares page loads", () => {
		expect(uiSource).toContain(
			"window.sendPluginCommand('ENSURE_DOCUMENT_CHANGE_TRACKING', {}, 120000)",
		);
		expect(uiSource).toContain("case 'ENSURE_DOCUMENT_CHANGE_TRACKING_RESULT':");
		expect(uiSource).toContain("initializeConnection(cloudWs, label)");
		expect(codeSource).toContain(
			"await __loadAllPagesAsync(msg.requestId, 'GET_LOCAL_COMPONENTS')",
		);
		expect(codeSource).toContain(
			"if (msg.type === 'ENSURE_DOCUMENT_CHANGE_TRACKING')",
		);
	});
});
