/**
 * Deterministic design-system fixtures and a latency-controlled Figma API
 * double for the design-system benchmark.
 */

import { performance } from "node:perf_hooks";

export const DESIGN_SYSTEM_FIXTURE_VERSION = "design-system-v1";

const COLLECTIONS = [
	{ name: "Primitives", modes: [{ modeId: "mode-default", name: "Default" }] },
	{
		name: "Semantic",
		modes: [
			{ modeId: "mode-light", name: "Light" },
			{ modeId: "mode-dark", name: "Dark" },
		],
	},
	{ name: "Spacing", modes: [{ modeId: "mode-default", name: "Default" }] },
	{ name: "Typography", modes: [{ modeId: "mode-default", name: "Default" }] },
];

function createRandom(seed) {
	let state = seed >>> 0 || 1;
	return () => {
		state = (state * 1664525 + 1013904223) >>> 0;
		return state / 0x100000000;
	};
}

function colorFor(index, random) {
	return {
		r: Number((0.08 + random() * 0.82).toFixed(4)),
		g: Number((0.08 + ((index * 17) % 83) / 100).toFixed(4)),
		b: Number((0.08 + random() * 0.82).toFixed(4)),
		a: 1,
	};
}

function createVariables(count, seed) {
	const random = createRandom(seed);
	const collections = COLLECTIONS.map((definition, index) => ({
		id: `collection-${index + 1}`,
		name: definition.name,
		key: `collection-key-${index + 1}`,
		modes: definition.modes,
		variableIds: [],
	}));
	const variables = {};
	const types = ["COLOR", "FLOAT", "STRING", "BOOLEAN"];

	for (let index = 0; index < count; index += 1) {
		const collection = collections[index % collections.length];
		const id = `variable-${index + 1}`;
		const type = types[index % types.length];
		const valuesByMode = {};
		for (const mode of collection.modes) {
			if (type === "COLOR") valuesByMode[mode.modeId] = colorFor(index, random);
			else if (type === "FLOAT") valuesByMode[mode.modeId] = (index % 24) + 1;
			else if (type === "BOOLEAN") valuesByMode[mode.modeId] = index % 2 === 0;
			else valuesByMode[mode.modeId] = `value-${index + 1}`;
		}
		variables[id] = {
			id,
			name: `${collection.name.toLowerCase()}/${type.toLowerCase()}/${index + 1}`,
			key: `variable-key-${index + 1}`,
			resolvedType: type,
			valuesByMode,
			variableCollectionId: collection.id,
			scopes: type === "FLOAT" ? ["GAP", "WIDTH_HEIGHT"] : ["ALL_FILLS"],
			description:
				index % 5 === 0 ? `Synthetic ${type.toLowerCase()} token` : "",
		};
		collection.variableIds.push(id);
	}

	return {
		variableCollections: Object.fromEntries(collections.map((c) => [c.id, c])),
		variables,
	};
}

function componentNode(id, name, index, type = "COMPONENT") {
	return {
		id,
		name,
		type,
		componentPropertyDefinitions: {
			variant: { type: "VARIANT", defaultValue: "Default" },
			density: { type: "VARIANT", defaultValue: "Regular" },
			disabled: { type: "BOOLEAN", defaultValue: false },
			label: { type: "TEXT", defaultValue: `Label ${index + 1}` },
		},
		absoluteBoundingBox: {
			x: 0,
			y: 0,
			width: 120 + (index % 4) * 8,
			height: 40 + (index % 3) * 4,
		},
		fills: [
			{
				type: "SOLID",
				color: { r: 0.1 + (index % 5) * 0.08, g: 0.2, b: 0.45, a: 1 },
				visible: true,
			},
		],
		strokes: [
			{
				type: "SOLID",
				color: { r: 0.2, g: 0.25, b: 0.35, a: 1 },
				visible: true,
			},
		],
		strokeWeight: 1,
		cornerRadius: 6 + (index % 3),
		layoutMode: "HORIZONTAL",
		paddingTop: 10,
		paddingRight: 16,
		paddingBottom: 10,
		paddingLeft: 16,
		itemSpacing: 8,
		primaryAxisAlignItems: "CENTER",
		counterAxisAlignItems: "CENTER",
	};
}

function createComponents(count, seed) {
	const random = createRandom(seed + 11);
	const setCount = Math.max(1, Math.floor(count / 10));
	const variantCount = 16;
	const componentSets = [];
	const components = [];
	const nodes = {};

	for (let setIndex = 0; setIndex < setCount; setIndex += 1) {
		const setId = `component-set-${setIndex + 1}`;
		const setName = `Component Set ${setIndex + 1}`;
		const children = [];
		for (let variantIndex = 0; variantIndex < variantCount; variantIndex += 1) {
			const id = `variant-${setIndex + 1}-${variantIndex + 1}`;
			const name = `State=${variantIndex % 2 ? "Hover" : "Default"}, Size=${variantIndex % 3 ? "Medium" : "Large"}`;
			components.push({
				node_id: id,
				name,
				description: "",
				component_set_id: setId,
				containing_frame: { nodeId: setId, containingComponentSet: true },
			});
			const node = componentNode(
				id,
				name,
				variantIndex + setIndex * variantCount,
			);
			if (variantIndex > 0 && variantIndex % 4 === 0) {
				node.fills[0].color.g = Number((0.2 + random() * 0.5).toFixed(3));
			}
			children.push(node);
		}
		const setNode = componentNode(setId, setName, setIndex, "COMPONENT_SET");
		setNode.children = children;
		setNode.componentPropertyDefinitions.variant.defaultValue = "Default";
		componentSets.push({
			node_id: setId,
			name: setName,
			description: "Synthetic component set with many variants",
		});
		nodes[setId] = setNode;
	}

	const standaloneCount = Math.max(0, count - setCount);
	for (let index = 0; index < standaloneCount; index += 1) {
		const id = `component-${index + 1}`;
		const name = `Component ${index + 1}`;
		components.push({
			node_id: id,
			name,
			description: index % 4 === 0 ? "Synthetic standalone component" : "",
			containing_frame: {
				nodeId: `frame-${index + 1}`,
				containingComponentSet: false,
			},
		});
		nodes[id] = componentNode(id, name, index);
	}

	return {
		componentCount: count,
		componentSetCount: setCount,
		components: { meta: { components } },
		componentSets: { meta: { component_sets: componentSets } },
		nodes,
	};
}

function createStyles(count) {
	const styles = [];
	const nodes = {};
	const styleTypes = ["FILL", "TEXT", "EFFECT"];
	for (let index = 0; index < count; index += 1) {
		const id = `style-node-${index + 1}`;
		const styleType = styleTypes[index % styleTypes.length];
		styles.push({
			key: `style-key-${index + 1}`,
			name: `${styleType.toLowerCase()}/style-${index + 1}`,
			style_type: styleType,
			description: index % 7 === 0 ? "Synthetic style" : "",
			node_id: id,
		});
		if (styleType === "TEXT") {
			nodes[id] = {
				id,
				type: "TEXT",
				style: {
					fontFamily: "Inter",
					fontSize: 12 + (index % 8),
					fontWeight: 400 + (index % 4) * 100,
					lineHeightPx: 18 + (index % 5),
				},
			};
		} else if (styleType === "EFFECT") {
			nodes[id] = {
				id,
				type: "RECTANGLE",
				effects: [
					{
						type: "DROP_SHADOW",
						color: { r: 0, g: 0, b: 0, a: 0.16 },
						offset: { x: 0, y: 2 },
						radius: 8,
						spread: 0,
						visible: true,
					},
				],
			};
		} else {
			nodes[id] = {
				id,
				type: "RECTANGLE",
				fills: [
					{
						type: "SOLID",
						color: { r: 0.12, g: 0.35, b: 0.85, a: 1 },
						visible: true,
					},
				],
			};
		}
	}
	return { styles: { meta: { styles } }, nodes };
}

export function createDesignSystemFixture({
	components = 10,
	variables = 100,
	seed = 1,
} = {}) {
	const variableData = createVariables(variables, seed);
	const componentData = createComponents(components, seed);
	const styleData = createStyles(Math.max(3, Math.ceil(components / 2)));
	return {
		version: DESIGN_SYSTEM_FIXTURE_VERSION,
		seed,
		componentCount: componentData.componentCount,
		componentSetCount: componentData.componentSetCount,
		variableCount: variables,
		styleCount: styleData.styles.meta.styles.length,
		variables: variableData,
		components: componentData.components,
		componentSets: componentData.componentSets,
		styles: styleData.styles,
		nodes: { ...componentData.nodes, ...styleData.nodes },
	};
}

function wait(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function unionDuration(records) {
	const intervals = records
		.map((record) => [record.startedAt, record.completedAt])
		.sort((a, b) => a[0] - b[0]);
	let total = 0;
	let start = null;
	let end = null;
	for (const [nextStart, nextEnd] of intervals) {
		if (start === null) {
			start = nextStart;
			end = nextEnd;
		} else if (nextStart <= end) {
			end = Math.max(end, nextEnd);
		} else {
			total += end - start;
			start = nextStart;
			end = nextEnd;
		}
	}
	return start === null ? 0 : total + end - start;
}

/**
 * Create an API double with deterministic fixed or seeded REST latency.
 * `beginOperation`/`endOperation` expose the I/O portion without guessing it
 * from wall time, including the overlap of Promise.all requests.
 */
export function createFakeFigmaAPI(
	fixture,
	{ latencyMs = 2, jitterMs = 0, seed = fixture.seed, mode = "fixed" } = {},
) {
	let randomState = seed >>> 0 || 1;
	let operationNumber = 0;
	const requests = [];
	let active = 0;
	let maxConcurrency = 0;

	function random() {
		randomState = (randomState * 1664525 + 1013904223) >>> 0;
		return randomState / 0x100000000;
	}

	function beginOperation() {
		const operationId = ++operationNumber;
		return { operationId, startedRequestIndex: requests.length };
	}

	function endOperation(handle) {
		const operationRequests = requests
			.slice(handle.startedRequestIndex)
			.filter((request) => request.operationId === handle.operationId);
		return {
			requestCount: operationRequests.length,
			simulatedRestWaitMs: operationRequests.reduce(
				(sum, request) => sum + request.latencyMs,
				0,
			),
			simulatedRestCriticalPathMs: unionDuration(operationRequests),
			maxConcurrency: operationRequests.reduce(
				(max, request) => Math.max(max, request.concurrency),
				0,
			),
			requests: operationRequests.map(
				({ name, latencyMs: requestLatencyMs }) => ({
					name,
					latencyMs: requestLatencyMs,
				}),
			),
		};
	}

	async function request(name, value, operationId) {
		const requestLatencyMs = Math.max(
			0,
			latencyMs +
				(mode === "seeded" && jitterMs > 0
					? Math.floor(random() * (jitterMs + 1))
					: 0),
		);
		const startedAt = performance.now();
		active += 1;
		maxConcurrency = Math.max(maxConcurrency, active);
		await wait(requestLatencyMs);
		active -= 1;
		requests.push({
			name,
			operationId,
			latencyMs: requestLatencyMs,
			startedAt,
			completedAt: performance.now(),
			concurrency: active + 1,
		});
		return value;
	}

	function currentOperationId() {
		return operationNumber;
	}

	const api = {
		beginOperation,
		endOperation,
		getRequestCount: () => requests.length,
		getMaxConcurrency: () => maxConcurrency,
		getComponents: (_fileKey) =>
			request("getComponents", fixture.components, currentOperationId()),
		getComponentSets: (_fileKey) =>
			request("getComponentSets", fixture.componentSets, currentOperationId()),
		getNodes: (_fileKey, nodeIds) =>
			request(
				"getNodes",
				{
					nodes: Object.fromEntries(
						nodeIds
							.filter((id) => fixture.nodes[id])
							.map((id) => [id, { document: fixture.nodes[id] }]),
					),
				},
				currentOperationId(),
			),
		getStyles: (_fileKey) =>
			request("getStyles", fixture.styles, currentOperationId()),
		getImages: (_fileKey, nodeIds) => {
			const ids = Array.isArray(nodeIds) ? nodeIds : [nodeIds];
			return request(
				"getImages",
				{
					images: Object.fromEntries(
						ids.map((id) => [
							id,
							`https://images.example.test/${fixture.seed}/${id}.png`,
						]),
					),
				},
				currentOperationId(),
			);
		},
		getLocalVariables: (_fileKey) =>
			request("getLocalVariables", fixture.variables, currentOperationId()),
	};

	return api;
}
