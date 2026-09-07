/**
 * PERF-01 regression coverage for the Desktop Bridge variable snapshot.
 *
 * The plugin files run in Figma's sandbox and are intentionally plain JS, so
 * these tests execute the isolated snapshot helper in a VM with a fake Figma
 * Variables API. The source-level assertions cover the startup and relay
 * wiring that cannot be exercised without Figma Desktop.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as vm from "node:vm";

const pluginDir = join(__dirname, "..", "figma-desktop-bridge");
const codeSource = readFileSync(join(pluginDir, "code.js"), "utf8");
const uiSource = readFileSync(join(pluginDir, "ui.html"), "utf8");

const helperStart = codeSource.indexOf("var __variablesSnapshot = null;");
const helperEnd = codeSource.indexOf(
	"\n// Helper to extract a component's SLOT contract",
	helperStart,
);

if (helperStart < 0 || helperEnd < 0) {
	throw new Error("Could not locate the PERF-01 variable snapshot helper");
}

const helperSource = codeSource.slice(helperStart, helperEnd);

function createSandbox(editorType = "figma") {
	const variables = [
		{
			id: "VariableID:1:1",
			name: "color/primary",
			key: "variable-key",
			resolvedType: "COLOR",
			valuesByMode: { "1:0": { r: 1, g: 0, b: 0, a: 1 } },
			variableCollectionId: "VariableCollectionId:1:0",
			scopes: ["ALL_SCOPES"],
			description: "",
			hiddenFromPublishing: false,
		},
	];
	const collections = [
		{
			id: "VariableCollectionId:1:0",
			name: "Tokens",
			key: "collection-key",
			modes: [{ modeId: "1:0", name: "Default" }],
			defaultModeId: "1:0",
			variableIds: ["VariableID:1:1"],
		},
	];
	let variableReadCount = 0;
	let collectionReadCount = 0;
	const postMessage = jest.fn();

	const sandbox: Record<string, any> = {
		__editorType: editorType,
		figma: {
			fileKey: "test-file",
			ui: { postMessage },
			variables: {
				getLocalVariablesAsync: jest.fn(async () => {
					variableReadCount++;
					return variables;
				}),
				getLocalVariableCollectionsAsync: jest.fn(async () => {
					collectionReadCount++;
					return collections;
				}),
			},
		},
		__benchmarkMeasure: (
			_stage: string,
			_requestId: string | null,
			work: () => any,
		) => work(),
		__benchmarkMeasureSync: (
			_stage: string,
			_requestId: string | null,
			work: () => any,
		) => work(),
		console,
	};

	vm.runInNewContext(
		`${helperSource}\nfunction serializeVariable(v) { return { id: v.id, name: v.name, key: v.key, resolvedType: v.resolvedType, valuesByMode: v.valuesByMode, variableCollectionId: v.variableCollectionId, scopes: v.scopes, codeSyntax: v.codeSyntax || {}, description: v.description, hiddenFromPublishing: v.hiddenFromPublishing }; }\nfunction serializeCollection(c) { return { id: c.id, name: c.name, key: c.key, modes: c.modes, defaultModeId: c.defaultModeId, variableIds: c.variableIds }; }`,
		sandbox,
	);

	return {
		sandbox,
		postMessage,
		get variableReadCount() {
			return variableReadCount;
		},
		get collectionReadCount() {
			return collectionReadCount;
		},
	};
}

describe("PERF-01 lazy variable snapshot", () => {
	it("does not read variables during Design-mode startup", () => {
		const startup = codeSource.slice(
			codeSource.indexOf("var __editorType"),
			helperStart,
		);

		expect(startup).not.toContain("getLocalVariablesAsync");
		expect(startup).not.toContain("getLocalVariableCollectionsAsync");
		expect(startup).not.toContain("Immediately fetch and send variables");
	});

	it("shares concurrent initial reads and caches successful repeats", async () => {
		const bridge = createSandbox();
		const first = bridge.sandbox.__getVariablesSnapshot(false, "request-1");
		const second = bridge.sandbox.__getVariablesSnapshot(false, "request-2");

		expect(first).toBe(second);
		const snapshot = await first;

		expect(snapshot.variables).toHaveLength(1);
		expect(bridge.variableReadCount).toBe(1);
		expect(bridge.collectionReadCount).toBe(1);

		const cached = await bridge.sandbox.__getVariablesSnapshot(
			false,
			"request-3",
		);
		expect(cached).toBe(snapshot);
		expect(bridge.variableReadCount).toBe(1);
		expect(bridge.collectionReadCount).toBe(1);
	});

	it("retries after a failed first read and refreshes live on demand", async () => {
		const bridge = createSandbox();
		let shouldFail = true;
		(
			bridge.sandbox.figma.variables.getLocalVariablesAsync as jest.Mock
		).mockImplementation(async () => {
			bridge.sandbox.__variableReadMarker =
				(bridge.sandbox.__variableReadMarker || 0) + 1;
			if (shouldFail) {
				shouldFail = false;
				throw new Error("temporary Plugin API failure");
			}
			return [
				{
					id: "VariableID:1:2",
					name: "color/recovered",
					key: "recovered-key",
					resolvedType: "COLOR",
					valuesByMode: {},
					variableCollectionId: "VariableCollectionId:1:0",
					scopes: [],
					description: "",
					hiddenFromPublishing: false,
				},
			];
		});

		await expect(
			bridge.sandbox.__getVariablesSnapshot(false, "failed"),
		).rejects.toThrow("temporary Plugin API failure");
		const recovered = await bridge.sandbox.__getVariablesSnapshot(
			false,
			"retry",
		);
		expect(recovered.variables[0].name).toBe("color/recovered");
		expect(bridge.sandbox.__variableReadMarker).toBe(2);

		await bridge.sandbox.__getVariablesSnapshot(true, "refresh");
		expect(bridge.sandbox.__variableReadMarker).toBe(3);
	});

	it("keeps the FigJam/Slides empty response without touching the Variables API", async () => {
		for (const editorType of ["figjam", "slides"]) {
			const bridge = createSandbox(editorType);
			const snapshot = await bridge.sandbox.__getVariablesSnapshot(
				false,
				"empty",
			);

			expect(snapshot.variables).toEqual([]);
			expect(snapshot.variableCollections).toEqual([]);
			expect(bridge.variableReadCount).toBe(0);
			expect(bridge.collectionReadCount).toBe(0);
			expect(bridge.postMessage).toHaveBeenCalledWith({
				type: "VARIABLES_DATA",
				data: snapshot,
			});
		}
	});

	it("routes GET_VARIABLES_DATA through the worker and clears the UI cache after writes", () => {
		expect(uiSource).toMatch(
			/'GET_VARIABLES_DATA': function\(\) \{[\s\S]*sendPluginCommand\('GET_VARIABLES_DATA', \{\}\)/,
		);
		expect(uiSource).toContain("case 'GET_VARIABLES_DATA_RESULT':");
		expect(uiSource).toContain("function invalidateVariablesDataCache()");

		const writeResultCases = [
			"UPDATE_VARIABLE_RESULT",
			"CREATE_VARIABLE_RESULT",
			"CREATE_VARIABLE_COLLECTION_RESULT",
			"DELETE_VARIABLE_RESULT",
			"DELETE_VARIABLE_COLLECTION_RESULT",
			"RENAME_VARIABLE_RESULT",
			"SET_VARIABLE_DESCRIPTION_RESULT",
			"ADD_MODE_RESULT",
			"RENAME_MODE_RESULT",
		];
		for (const resultType of writeResultCases) {
			const start = uiSource.indexOf(`case '${resultType}':`);
			const next = uiSource.indexOf("\n        case '", start + 1);
			expect(start).toBeGreaterThan(-1);
			expect(uiSource.slice(start, next < 0 ? undefined : next)).toContain(
				"invalidateVariablesDataCache()",
			);
		}
	});

	it("invalidates the worker snapshot from every dedicated variable write", () => {
		const writeTypes = [
			"UPDATE_VARIABLE",
			"CREATE_VARIABLE",
			"CREATE_VARIABLE_COLLECTION",
			"DELETE_VARIABLE",
			"DELETE_VARIABLE_COLLECTION",
			"RENAME_VARIABLE",
			"SET_VARIABLE_DESCRIPTION",
			"ADD_MODE",
			"RENAME_MODE",
		];

		for (const writeType of writeTypes) {
			const start = codeSource.indexOf(`else if (msg.type === '${writeType}')`);
			const next = codeSource.indexOf("\n  else if (msg.type === '", start + 1);
			expect(start).toBeGreaterThan(-1);
			expect(codeSource.slice(start, next < 0 ? undefined : next)).toContain(
				"__invalidateVariablesSnapshot();",
			);
		}
	});
});
