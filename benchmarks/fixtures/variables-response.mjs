export const VARIABLES_FIXTURE_VERSION = 1;

const COLLECTION_COUNT = 3;
const VARIABLES_PER_COLLECTION = 40;

function colorValue(index, modeOffset) {
	return {
		r: ((index * 37 + modeOffset * 11) % 255) / 255,
		g: ((index * 67 + modeOffset * 17) % 255) / 255,
		b: ((index * 97 + modeOffset * 23) % 255) / 255,
		a: 1,
	};
}

function valueForType(type, index, modeOffset) {
	if (type === "COLOR") return colorValue(index, modeOffset);
	if (type === "FLOAT") return index * 4 + modeOffset * 2;
	if (type === "BOOLEAN") return (index + modeOffset) % 2 === 0;
	return `Content value ${index} (${modeOffset === 0 ? "light" : "dark"})`;
}

/**
 * Deterministic, synthetic fixture matching the Desktop Bridge variables shape.
 * It includes multiple collections, modes, resolved types, aliases, scopes,
 * descriptions, code syntax, and publishing flags without containing private data.
 */
export function createVariablesResponseFixture() {
	const variableCollections = [];
	const variables = [];
	const types = ["COLOR", "FLOAT", "STRING", "BOOLEAN"];

	for (
		let collectionIndex = 0;
		collectionIndex < COLLECTION_COUNT;
		collectionIndex += 1
	) {
		const collectionId = `VariableCollectionId:benchmark:${collectionIndex}`;
		const lightModeId = `mode:benchmark:${collectionIndex}:light`;
		const darkModeId = `mode:benchmark:${collectionIndex}:dark`;
		const variableIds = [];

		for (
			let itemIndex = 0;
			itemIndex < VARIABLES_PER_COLLECTION;
			itemIndex += 1
		) {
			const globalIndex =
				collectionIndex * VARIABLES_PER_COLLECTION + itemIndex;
			const id = `VariableID:benchmark:${globalIndex}`;
			const resolvedType = types[globalIndex % types.length];
			variableIds.push(id);

			const lightValue = valueForType(resolvedType, globalIndex, 0);
			const darkValue =
				itemIndex > 0 && itemIndex % 11 === 0
					? {
							type: "VARIABLE_ALIAS",
							id: `VariableID:benchmark:${globalIndex - 1}`,
						}
					: valueForType(resolvedType, globalIndex, 1);

			variables.push({
				id,
				key: `benchmark-variable-key-${globalIndex.toString().padStart(4, "0")}`,
				name: `semantic/${collectionIndex}/${resolvedType.toLowerCase()}/token-${itemIndex}`,
				variableCollectionId: collectionId,
				resolvedType,
				valuesByMode: {
					[lightModeId]: lightValue,
					[darkModeId]: darkValue,
				},
				remote: itemIndex % 13 === 0,
				scopes:
					resolvedType === "COLOR"
						? ["ALL_FILLS", "STROKE_COLOR"]
						: resolvedType === "FLOAT"
							? ["GAP", "WIDTH_HEIGHT"]
							: ["ALL_SCOPES"],
				description: `Synthetic benchmark variable ${globalIndex}`,
				hiddenFromPublishing: itemIndex % 17 === 0,
				codeSyntax: {
					WEB: `var(--benchmark-${collectionIndex}-${itemIndex})`,
					ANDROID: `BenchmarkTokens.token${globalIndex}`,
				},
			});
		}

		variableCollections.push({
			id: collectionId,
			key: `benchmark-collection-key-${collectionIndex}`,
			name: `Benchmark Collection ${collectionIndex + 1}`,
			modes: [
				{ modeId: lightModeId, name: "Light" },
				{ modeId: darkModeId, name: "Dark" },
			],
			defaultModeId: lightModeId,
			variableIds,
			hiddenFromPublishing: false,
		});
	}

	return {
		success: true,
		fileKey: "benchmark-file-key",
		editorType: "figma",
		variables,
		variableCollections,
	};
}
