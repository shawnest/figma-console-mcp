/**
 * Design System Kit Tool
 * MCP tool that orchestrates existing Figma API tools to produce a structured
 * design system specification — tokens, components, styles — in a single call.
 *
 * This enables AI code generation tools (Figma Make, v0, Cursor, Claude, etc.)
 * to generate code with structural fidelity to the real design system.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { FigmaAPI } from "./figma-api.js";
import { extractFileKey, formatComponentData } from "./figma-api.js";
import { resolveFormattedVariables } from "./variable-resolver.js";
import { createChildLogger } from "./logger.js";

const logger = createChildLogger({ component: "design-system-tools" });

// ============================================================================
// Types
// ============================================================================

export interface TokenCollection {
	id: string;
	name: string;
	modes: Array<{ modeId: string; name: string }>;
	variables: Array<{
		id: string;
		name: string;
		type: string;
		description?: string;
		valuesByMode: Record<string, any>;
		scopes?: string[];
	}>;
}

export interface VisualSpec {
	fills?: Array<{ type: string; color?: string; opacity?: number }>;
	strokes?: Array<{
		type: string;
		color?: string;
		weight?: number;
		align?: string;
	}>;
	effects?: Array<{
		type: string;
		color?: string;
		offset?: { x: number; y: number };
		radius?: number;
		spread?: number;
	}>;
	cornerRadius?: number;
	rectangleCornerRadii?: number[];
	opacity?: number;
	layout?: {
		mode?: string; // HORIZONTAL | VERTICAL
		paddingTop?: number;
		paddingRight?: number;
		paddingBottom?: number;
		paddingLeft?: number;
		itemSpacing?: number;
		primaryAxisAlign?: string;
		counterAxisAlign?: string;
	};
	typography?: {
		fontFamily?: string;
		fontSize?: number;
		fontWeight?: number;
		lineHeight?: any;
		letterSpacing?: any;
		textAlignHorizontal?: string;
	};
}

export interface ComponentSpec {
	id: string;
	name: string;
	description?: string;
	properties?: Record<string, any>;
	variants?: Array<{
		name: string;
		id: string;
		visualSpec?: VisualSpec;
		visualSpecDelta?: Record<string, any>;
	}>;
	bounds?: { width: number; height: number };
	imageUrl?: string;
	visualSpec?: VisualSpec;
}

export interface StyleSpec {
	key: string;
	name: string;
	styleType: string;
	description?: string;
	nodeId?: string;
	resolvedValue?: any;
}

export interface DesignSystemKit {
	fileKey: string;
	fileName?: string;
	generatedAt: string;
	format: string;
	tokens?: {
		collections: TokenCollection[];
		summary: {
			totalCollections: number;
			totalVariables: number;
			variablesByType: Record<string, number>;
		};
	};
	components?: {
		items: ComponentSpec[];
		summary: {
			totalComponents: number;
			totalComponentSets: number;
		};
	};
	styles?: {
		items: StyleSpec[];
		summary: {
			totalStyles: number;
			stylesByType: Record<string, number>;
		};
	};
	errors?: Array<{ section: string; message: string }>;
	ai_instruction: string;
}

export interface DesignSystemKitCacheEntry {
	fileKey: string;
	data: DesignSystemKit;
	timestamp: number;
}

/**
 * Short-lived cache for complete design-system kit snapshots.
 *
 * The cache is deliberately kept outside the assembly function so local mode
 * can reuse successful reads while cloud/stateless requests remain uncached.
 * In-flight requests are coalesced to avoid duplicate REST crawls when several
 * callers ask for the same snapshot at once.
 */
export class DesignSystemKitCache {
	static readonly TTL_MS = 5 * 60 * 1000;
	static readonly MAX_ENTRIES = 100;

	private readonly entries = new Map<string, DesignSystemKitCacheEntry>();
	private readonly inFlight = new Map<
		string,
		{ fileKey: string; promise: Promise<DesignSystemKit> }
	>();
	private readonly fileGenerations = new Map<string, number>();
	private globalGeneration = 0;

	get(key: string, now = Date.now()): DesignSystemKit | undefined {
		const entry = this.entries.get(key);
		if (!entry) return undefined;

		if (now - entry.timestamp >= DesignSystemKitCache.TTL_MS) {
			this.entries.delete(key);
			return undefined;
		}

		return entry.data;
	}

	set(
		key: string,
		fileKey: string,
		data: DesignSystemKit,
		timestamp = Date.now(),
	): void {
		if (
			!this.entries.has(key) &&
			this.entries.size >= DesignSystemKitCache.MAX_ENTRIES
		) {
			const oldestKey = this.entries.keys().next().value;
			if (typeof oldestKey === "string") this.entries.delete(oldestKey);
		}
		this.entries.set(key, { fileKey, data, timestamp });
	}

	getOrCreate(
		key: string,
		fileKey: string,
		factory: () => Promise<DesignSystemKit>,
	): Promise<DesignSystemKit> {
		const cached = this.get(key);
		if (cached) return Promise.resolve(cached);

		const existing = this.inFlight.get(key);
		if (existing) return existing.promise;

		const generation = this.fileGenerations.get(fileKey) ?? 0;
		const globalGeneration = this.globalGeneration;
		let promise: Promise<DesignSystemKit>;
		promise = factory()
			.then((data) => {
				// Error responses and results completed before an invalidation must
				// never become the next cached snapshot.
				if (
					!data.errors?.length &&
					this.globalGeneration === globalGeneration &&
					(this.fileGenerations.get(fileKey) ?? 0) === generation
				) {
					this.set(key, fileKey, data);
				}
				return data;
			})
			.finally(() => {
				if (this.inFlight.get(key)?.promise === promise) {
					this.inFlight.delete(key);
				}
			});
		this.inFlight.set(key, { fileKey, promise });
		return promise;
	}

	invalidate(fileKey: string): void {
		this.fileGenerations.set(
			fileKey,
			(this.fileGenerations.get(fileKey) ?? 0) + 1,
		);
		for (const [key, entry] of this.entries) {
			if (entry.fileKey === fileKey) this.entries.delete(key);
		}
		for (const [key, entry] of this.inFlight) {
			// The promise cannot be cancelled, but removing it ensures a request
			// started after invalidation does not join the stale operation.
			if (entry.fileKey === fileKey) this.inFlight.delete(key);
		}
	}

	clear(): void {
		this.globalGeneration++;
		this.entries.clear();
		this.inFlight.clear();
	}
}

export type DesignSystemKitSection = "tokens" | "components" | "styles";
export type DesignSystemKitFormat = "full" | "summary" | "compact";

/** The REST methods used by the design-system kit assembly path. */
export interface DesignSystemKitApi
	extends Pick<FigmaAPI, "getLocalVariables"> {
	getComponents(fileKey: string): Promise<any>;
	getComponentSets(fileKey: string): Promise<any>;
	getNodes(
		fileKey: string,
		nodeIds: string[],
		options?: { depth?: number },
	): Promise<any>;
	getStyles(fileKey: string): Promise<any>;
	getImages(
		fileKey: string,
		nodeIds: string | string[],
		options?: { scale?: number; format?: "png" | "jpg" | "svg" | "pdf" },
	): Promise<{ images: Record<string, string | null> }>;
}

export interface AssembleDesignSystemKitOptions {
	api: DesignSystemKitApi;
	fileKey: string;
	include?: DesignSystemKitSection[];
	componentIds?: string[];
	includeImages?: boolean;
	format?: DesignSystemKitFormat;
	variablesCache?: Map<string, { data: any; timestamp: number }>;
	designSystemCache?: DesignSystemKitCache;
	getDesktopConnector?: () => Promise<any>;
	/** Injected by benchmarks/tests when a stable generatedAt is useful. */
	now?: () => string;
}

function createDesignSystemKitCacheKey(
	options: AssembleDesignSystemKitOptions,
	include: DesignSystemKitSection[],
): string {
	return [
		"design-system-kit:v1",
		options.fileKey,
		JSON.stringify({
			include,
			componentIds: options.componentIds ?? null,
			includeImages: options.includeImages ?? false,
			format: options.format ?? "full",
		}),
	].join(":");
}

/**
 * Keep independent kit sections concurrent without allowing their REST calls
 * to overwhelm the relay or Figma's rate limits.
 */
function createRequestLimitedApi(
	api: DesignSystemKitApi,
	maxConcurrent = 4,
): DesignSystemKitApi {
	let active = 0;
	const queue: Array<{
		task: () => Promise<any>;
		resolve: (value: any) => void;
		reject: (reason?: any) => void;
	}> = [];

	const drain = (): void => {
		while (active < maxConcurrent && queue.length > 0) {
			const next = queue.shift() as (typeof queue)[number];
			active++;
			next
				.task()
				.then(next.resolve, next.reject)
				.finally(() => {
					active--;
					drain();
				});
		}
	};

	const limited = <T>(task: () => Promise<T>): Promise<T> =>
		new Promise<T>((resolve, reject) => {
			queue.push({ task, resolve, reject });
			drain();
		});

	return {
		getLocalVariables: (fileKey) =>
			limited(() => api.getLocalVariables(fileKey)),
		getComponents: (fileKey) => limited(() => api.getComponents(fileKey)),
		getComponentSets: (fileKey) => limited(() => api.getComponentSets(fileKey)),
		getNodes: (fileKey, nodeIds, options) =>
			limited(() => api.getNodes(fileKey, nodeIds, options)),
		getStyles: (fileKey) => limited(() => api.getStyles(fileKey)),
		getImages: (fileKey, nodeIds, options) =>
			limited(() => api.getImages(fileKey, nodeIds, options)),
	};
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Calculate JSON size in KB for response management
 */
function calculateSizeKB(data: any): number {
	return JSON.stringify(data).length / 1024;
}

/**
 * Wrap a promise with a timeout to prevent indefinite hangs
 */
function withTimeout<T>(
	promise: Promise<T>,
	ms: number,
	label: string,
): Promise<T> {
	let timeoutId: ReturnType<typeof setTimeout>;
	const timeoutPromise = new Promise<never>((_, reject) => {
		timeoutId = setTimeout(
			() => reject(new Error(`${label} timed out after ${ms}ms`)),
			ms,
		);
	});
	return Promise.race([promise, timeoutPromise]).finally(() =>
		clearTimeout(timeoutId),
	);
}

/**
 * Convert Figma RGBA (0-1 range) to hex string
 */
function rgbaToHex(color: {
	r: number;
	g: number;
	b: number;
	a?: number;
}): string {
	const r = Math.round(color.r * 255);
	const g = Math.round(color.g * 255);
	const b = Math.round(color.b * 255);
	const hex = `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
	return hex.toUpperCase();
}

/**
 * Extract a compact visual specification from a Figma node.
 * Captures the essential CSS-equivalent properties an AI needs to reproduce the component.
 */
export function extractVisualSpec(node: any): VisualSpec | undefined {
	if (!node) return undefined;

	const spec: VisualSpec = {};
	let hasData = false;

	// Fills → background colors/gradients
	if (node.fills && Array.isArray(node.fills) && node.fills.length > 0) {
		spec.fills = node.fills
			.filter((f: any) => f.visible !== false)
			.map((f: any) => {
				const fill: any = { type: f.type };
				if (f.color) fill.color = rgbaToHex(f.color);
				if (f.opacity !== undefined) fill.opacity = f.opacity;
				return fill;
			});
		if (spec.fills!.length > 0) hasData = true;
	}

	// Strokes → borders
	if (node.strokes && Array.isArray(node.strokes) && node.strokes.length > 0) {
		spec.strokes = node.strokes
			.filter((s: any) => s.visible !== false)
			.map((s: any) => {
				const stroke: any = { type: s.type };
				if (s.color) stroke.color = rgbaToHex(s.color);
				return stroke;
			});
		if (node.strokeWeight !== undefined)
			spec.strokes!.forEach((s: any) => (s.weight = node.strokeWeight));
		if (node.strokeAlign)
			spec.strokes!.forEach((s: any) => (s.align = node.strokeAlign));
		if (spec.strokes!.length > 0) hasData = true;
	}

	// Effects → shadows, blurs
	if (node.effects && Array.isArray(node.effects) && node.effects.length > 0) {
		spec.effects = node.effects
			.filter((e: any) => e.visible !== false)
			.map((e: any) => {
				const effect: any = { type: e.type };
				if (e.color) effect.color = rgbaToHex(e.color);
				if (e.offset) effect.offset = e.offset;
				if (e.radius !== undefined) effect.radius = e.radius;
				if (e.spread !== undefined) effect.spread = e.spread;
				return effect;
			});
		if (spec.effects!.length > 0) hasData = true;
	}

	// Corner radius
	if (node.cornerRadius !== undefined && node.cornerRadius > 0) {
		spec.cornerRadius = node.cornerRadius;
		hasData = true;
	}
	if (node.rectangleCornerRadii) {
		spec.rectangleCornerRadii = node.rectangleCornerRadii;
		hasData = true;
	}

	// Opacity
	if (node.opacity !== undefined && node.opacity < 1) {
		spec.opacity = node.opacity;
		hasData = true;
	}

	// Auto-layout → CSS flex equivalent
	if (node.layoutMode && node.layoutMode !== "NONE") {
		spec.layout = {
			mode: node.layoutMode,
		};
		if (node.paddingTop !== undefined) spec.layout.paddingTop = node.paddingTop;
		if (node.paddingRight !== undefined)
			spec.layout.paddingRight = node.paddingRight;
		if (node.paddingBottom !== undefined)
			spec.layout.paddingBottom = node.paddingBottom;
		if (node.paddingLeft !== undefined)
			spec.layout.paddingLeft = node.paddingLeft;
		if (node.itemSpacing !== undefined)
			spec.layout.itemSpacing = node.itemSpacing;
		if (node.primaryAxisAlignItems)
			spec.layout.primaryAxisAlign = node.primaryAxisAlignItems;
		if (node.counterAxisAlignItems)
			spec.layout.counterAxisAlign = node.counterAxisAlignItems;
		hasData = true;
	}

	// Typography (for TEXT nodes)
	if (node.type === "TEXT" && node.style) {
		spec.typography = {};
		const s = node.style;
		if (s.fontFamily) spec.typography.fontFamily = s.fontFamily;
		if (s.fontSize) spec.typography.fontSize = s.fontSize;
		if (s.fontWeight) spec.typography.fontWeight = s.fontWeight;
		if (s.lineHeightPx) spec.typography.lineHeight = s.lineHeightPx;
		if (s.letterSpacing) spec.typography.letterSpacing = s.letterSpacing;
		if (s.textAlignHorizontal)
			spec.typography.textAlignHorizontal = s.textAlignHorizontal;
		hasData = true;
	}

	return hasData ? spec : undefined;
}

/**
 * Delta-encode variant visual specs against the first variant that has one.
 * Variants in a set share most visual properties, so repeating the full spec
 * on every variant inflates the payload ~30x for large sets. The base variant
 * keeps its full visualSpec; every other variant gets a visualSpecDelta with
 * only the top-level properties that differ from the base (null means the
 * property exists on the base but not on this variant). Variants identical to
 * the base carry neither field.
 */
function deltaEncodeVariantSpecs(
	variants: Array<{
		name: string;
		id: string;
		visualSpec?: VisualSpec;
		visualSpecDelta?: Record<string, any>;
	}>,
): void {
	const base = variants.find((v) => v.visualSpec);
	if (!base) return;
	const baseSpec = base.visualSpec as Record<string, any>;

	for (const variant of variants) {
		if (variant === base || !variant.visualSpec) continue;
		const spec = variant.visualSpec as Record<string, any>;
		const delta: Record<string, any> = {};

		for (const key of new Set([
			...Object.keys(baseSpec),
			...Object.keys(spec),
		])) {
			if (!(key in spec)) {
				delta[key] = null;
			} else if (
				!(key in baseSpec) ||
				JSON.stringify(spec[key]) !== JSON.stringify(baseSpec[key])
			) {
				delta[key] = spec[key];
			}
		}

		delete variant.visualSpec;
		if (Object.keys(delta).length > 0) variant.visualSpecDelta = delta;
	}
}

/**
 * Resolve style node IDs to their actual visual values.
 * Styles only contain metadata from the styles endpoint — we need getNodes to get actual colors/fonts/effects.
 */
async function resolveStyleValues(
	api: DesignSystemKitApi,
	fileKey: string,
	styles: StyleSpec[],
): Promise<Map<string, any>> {
	const resolved = new Map<string, any>();
	const nodeIds = styles.filter((s) => s.nodeId).map((s) => s.nodeId as string);

	if (nodeIds.length === 0) return resolved;

	const batchSize = 50;
	const nodeResponses = await Promise.all(
		Array.from(
			{ length: Math.ceil(nodeIds.length / batchSize) },
			(_, batchIndex) => {
				const batch = nodeIds.slice(
					batchIndex * batchSize,
					(batchIndex + 1) * batchSize,
				);
				return (async () => {
					try {
						return await withTimeout(
							api.getNodes(fileKey, batch),
							30000,
							`getStyleNodes(batch ${batchIndex + 1})`,
						);
					} catch (err) {
						logger.warn(
							{ error: err, batch: batchIndex + 1 },
							"Failed to resolve style node batch",
						);
						return null;
					}
				})();
			},
		),
	);

	for (const nodeResponse of nodeResponses) {
		if (nodeResponse?.nodes) {
			for (const [nodeId, nodeData] of Object.entries(nodeResponse.nodes)) {
				const doc = (nodeData as any)?.document;
				if (!doc) continue;

				const value: any = {};

				// FILL styles → extract colors
				if (doc.fills && Array.isArray(doc.fills)) {
					value.fills = doc.fills
						.filter((f: any) => f.visible !== false)
						.map((f: any) => ({
							type: f.type,
							color: f.color ? rgbaToHex(f.color) : undefined,
							opacity: f.opacity,
						}));
				}

				// TEXT styles → extract typography
				if (doc.type === "TEXT" && doc.style) {
					value.typography = {
						fontFamily: doc.style.fontFamily,
						fontSize: doc.style.fontSize,
						fontWeight: doc.style.fontWeight,
						lineHeight: doc.style.lineHeightPx,
						letterSpacing: doc.style.letterSpacing,
					};
				}

				// EFFECT styles → extract shadows/blurs
				if (doc.effects && Array.isArray(doc.effects)) {
					value.effects = doc.effects
						.filter((e: any) => e.visible !== false)
						.map((e: any) => ({
							type: e.type,
							color: e.color ? rgbaToHex(e.color) : undefined,
							offset: e.offset,
							radius: e.radius,
							spread: e.spread,
						}));
				}

				resolved.set(nodeId, value);
			}
		}
	}

	return resolved;
}

/**
 * Group variables by collection for a clean hierarchical output
 */
function groupVariablesByCollection(formatted: {
	collections: any[];
	variables: any[];
}): TokenCollection[] {
	const variablesByCollection = new Map<
		string,
		TokenCollection["variables"]
	>();
	for (const variable of formatted.variables) {
		if (typeof variable.variableCollectionId !== "string") continue;
		const collectionVariables = variablesByCollection.get(
			variable.variableCollectionId,
		);
		const mappedVariable = {
			id: variable.id,
			name: variable.name,
			type: variable.resolvedType,
			description: variable.description || undefined,
			valuesByMode: variable.valuesByMode,
			scopes: variable.scopes,
		};
		if (collectionVariables) collectionVariables.push(mappedVariable);
		else
			variablesByCollection.set(variable.variableCollectionId, [mappedVariable]);
	}

	return formatted.collections.map((collection) => {
		return {
			id: collection.id,
			name: collection.name,
			modes: collection.modes,
			variables: variablesByCollection.get(collection.id) || [],
		};
	});
}

/**
 * Deduplicate components — filter out individual variants when their
 * parent component set is already present.
 */
function deduplicateComponents(
	components: any[],
	componentSets: any[],
): { components: any[]; componentSets: any[] } {
	const setNodeIds = new Set(componentSets.map((s: any) => s.node_id));

	// Filter out variants that belong to a known component set
	const standalone = components.filter((c: any) => {
		if (c.containing_frame?.containingComponentSet) {
			// This is a variant — check if parent set is already included
			// Check both direct frame nodeId and the containingComponentSet.nodeId
			// (some designs nest variants inside intermediate frames)
			const frameNodeId = c.containing_frame?.nodeId;
			const setNodeId = c.containing_frame?.containingComponentSet?.nodeId;
			if (
				(frameNodeId && setNodeIds.has(frameNodeId)) ||
				(setNodeId && setNodeIds.has(setNodeId))
			) {
				return false; // Skip, parent set covers it
			}
		}
		return true;
	});

	return { components: standalone, componentSets };
}

/**
 * Compress the kit for large responses
 */
function compressKit(
	kit: DesignSystemKit,
	level: "summary" | "inventory" | "compact",
): DesignSystemKit {
	const compressed = { ...kit };

	if (compressed.tokens) {
		if (level === "compact") {
			// Compact: only summary counts, drop all collections/variables
			compressed.tokens = {
				collections: [],
				summary: compressed.tokens.summary,
			};
		} else if (level === "inventory") {
			// Only keep variable names and types, drop values
			compressed.tokens = {
				...compressed.tokens,
				collections: compressed.tokens.collections.map((c) => ({
					...c,
					variables: c.variables.map((v) => ({
						id: v.id,
						name: v.name,
						type: v.type,
						description: v.description,
						valuesByMode: {}, // Strip values
						scopes: v.scopes,
					})),
				})),
			};
		}
	}

	if (compressed.components) {
		if (level === "compact") {
			// Compact: drastically reduce for large systems
			// Separate component sets (design building blocks) from standalone components
			const sets = compressed.components.items.filter(
				(c) => c.variants && c.variants.length > 0,
			);
			const standalone = compressed.components.items.filter(
				(c) => !c.variants || c.variants.length === 0,
			);

			// Keep all sets (they're the main building blocks), limit standalone to 100
			const limitedStandalone = standalone.slice(0, 100);
			const trimmedItems = [...sets, ...limitedStandalone];

			compressed.components = {
				...compressed.components,
				items: trimmedItems.map((c) => ({
					id: c.id,
					name: c.name,
					// Compact: variant count only (not individual names) for very large sets
					variants: c.variants
						? c.variants.length > 10
							? [{ name: `${c.variants.length} variants`, id: "" }]
							: c.variants.map((v) => ({ name: v.name, id: v.id }))
						: undefined,
					properties: c.properties
						? Object.fromEntries(
								Object.entries(c.properties).map(([k, v]: [string, any]) => [
									k,
									{ type: v.type, defaultValue: v.defaultValue },
								]),
							)
						: undefined,
				})),
				summary: {
					...compressed.components.summary,
					totalComponents: trimmedItems.length,
					...(standalone.length > 100
						? ({ omittedStandaloneComponents: standalone.length - 100 } as any)
						: {}),
				},
			};
		} else if (level === "inventory") {
			// Only keep names and property keys — strip visual specs and variants
			compressed.components = {
				...compressed.components,
				items: compressed.components.items.map((c) => ({
					id: c.id,
					name: c.name,
					description: c.description,
					properties: c.properties
						? Object.fromEntries(
								Object.entries(c.properties).map(([k, v]: [string, any]) => [
									k,
									{ type: v.type, defaultValue: v.defaultValue },
								]),
							)
						: undefined,
				})),
			};
		} else if (level === "summary") {
			// Keep visual specs but strip variant-level specs to save space
			compressed.components = {
				...compressed.components,
				items: compressed.components.items.map((c) => ({
					...c,
					variants: c.variants?.map((v) => ({ name: v.name, id: v.id })),
				})),
			};
		}
		// Drop image URLs at any compression level to save tokens
		compressed.components.items = compressed.components.items.map((c) => {
			const { imageUrl, ...rest } = c;
			return rest;
		});
	}

	if (compressed.styles) {
		if (level === "compact") {
			// Compact: only style names and types grouped by type, no resolved values
			compressed.styles = {
				...compressed.styles,
				items: compressed.styles.items.map((s) => ({
					key: s.key,
					name: s.name,
					styleType: s.styleType,
				})),
			};
		} else if (level === "inventory") {
			// Strip resolved values in inventory mode
			compressed.styles = {
				...compressed.styles,
				items: compressed.styles.items.map((s) => ({
					key: s.key,
					name: s.name,
					styleType: s.styleType,
					description: s.description,
				})),
			};
		}
	}

	return compressed;
}

// ============================================================================
// Tool Registration
// ============================================================================

/**
 * Assemble a design-system kit without going through the MCP text protocol.
 *
 * Keeping this function independent from tool registration makes the expensive
 * server-side path measurable with a deterministic API double while the MCP
 * handler below continues to exercise the public end-to-end contract.
 */
export async function assembleDesignSystemKit(
	options: AssembleDesignSystemKitOptions,
): Promise<DesignSystemKit> {
	const include = options.include ?? ["tokens", "components", "styles"];
	if (options.designSystemCache) {
		const cacheKey = createDesignSystemKitCacheKey(options, include);
		return options.designSystemCache.getOrCreate(
			cacheKey,
			options.fileKey,
			() => assembleDesignSystemKitUncached({ ...options, include }),
		);
	}

	return assembleDesignSystemKitUncached(options);
}

async function assembleDesignSystemKitUncached(
	options: AssembleDesignSystemKitOptions,
): Promise<DesignSystemKit> {
	const {
		api,
		fileKey,
		componentIds,
		includeImages = false,
		format = "full",
		variablesCache,
		getDesktopConnector,
		now = () => new Date().toISOString(),
	} = options;
	const include = options.include ?? ["tokens", "components", "styles"];
	const requestApi = createRequestLimitedApi(api);
	const sectionTasks: Promise<void>[] = [];
	const errors: Array<{ section: string; message: string }> = [];
	const kit: DesignSystemKit = {
		fileKey,
		generatedAt: now(),
		format,
		ai_instruction: "",
	};

	if (include.includes("tokens")) {
		sectionTasks.push(
			(async () => {
				try {
					const cacheKey = `vars:${fileKey}`;
					let formatted: {
						collections: any[];
						variables: any[];
						summary: any;
					} | null = null;

					if (variablesCache) {
						const cached = variablesCache.get(cacheKey);
						if (cached && Date.now() - cached.timestamp < 5 * 60 * 1000) {
							formatted = cached.data;
						}
					}

					if (!formatted) {
						formatted = await resolveFormattedVariables({
							getDesktopConnector,
							getFigmaAPI: async () => requestApi as FigmaAPI,
							fileKey,
						});
						variablesCache?.set(cacheKey, {
							data: formatted,
							timestamp: Date.now(),
						});
					}

					kit.tokens = {
						collections: groupVariablesByCollection(formatted),
						summary: formatted.summary,
					};
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					errors.push({ section: "tokens", message });
				}
			})(),
		);
	}

	if (include.includes("components")) {
		sectionTasks.push(
			(async () => {
				try {
					const [componentsResponse, componentSetsResponse] = await Promise.all(
						[
							withTimeout(
								requestApi.getComponents(fileKey),
								30000,
								"getComponents",
							),
							withTimeout(
								requestApi.getComponentSets(fileKey),
								30000,
								"getComponentSets",
							),
						],
					);
					const allComponents = componentsResponse?.meta?.components || [];
					const allComponentSets =
						componentSetsResponse?.meta?.component_sets || [];
					const { components: standaloneComponents, componentSets } =
						deduplicateComponents(allComponents, allComponentSets);
					const componentsBySetId = new Map<string, any[]>();
					const addComponentToSetIndex = (
						setId: unknown,
						component: any,
					): void => {
						if (typeof setId !== "string" || setId.length === 0) return;
						const components = componentsBySetId.get(setId);
						if (components) components.push(component);
						else componentsBySetId.set(setId, [component]);
					};
					for (const component of allComponents) {
						const componentSetId = component.component_set_id;
						const containingFrameId = component.containing_frame?.nodeId;
						const containingComponentSetId =
							component.containing_frame?.containingComponentSet?.nodeId;
						addComponentToSetIndex(componentSetId, component);
						if (containingFrameId !== componentSetId) {
							addComponentToSetIndex(containingFrameId, component);
						}
						if (
							containingComponentSetId !== componentSetId &&
							containingComponentSetId !== containingFrameId
						) {
							addComponentToSetIndex(containingComponentSetId, component);
						}
					}
					let targetComponents = standaloneComponents;
					let targetSets = componentSets;

					if (componentIds && componentIds.length > 0) {
						const idSet = new Set(componentIds);
						targetComponents = standaloneComponents.filter((component: any) =>
							idSet.has(component.node_id),
						);
						targetSets = componentSets.filter((set: any) =>
							idSet.has(set.node_id),
						);
					}

					const componentSpecs: ComponentSpec[] = [];
					const needsComponentVisuals = format !== "compact";
					const needsVariantVisuals = format === "full";
					const allNodeIds = [
						...targetSets.map((set: any) => set.node_id),
						...targetComponents.map((component: any) => component.node_id),
					];
					const nodeDepth = needsVariantVisuals ? 2 : 1;
					const nodeDetailsMap: Record<string, any> = {};
					const batchSize = 50;
					const nodeResponses = await Promise.all(
						Array.from(
							{ length: Math.ceil(allNodeIds.length / batchSize) },
							(_, batchIndex) => {
								const batch = allNodeIds.slice(
									batchIndex * batchSize,
									(batchIndex + 1) * batchSize,
								);
								return (async () => {
									try {
										return await withTimeout(
											requestApi.getNodes(fileKey, batch, { depth: nodeDepth }),
											30000,
											`getNodes(batch ${batchIndex + 1})`,
										);
									} catch (err) {
										// Match the previous behavior: a failed detail batch does not discard
										// the component inventory returned by the metadata endpoints.
										return null;
									}
								})();
							},
						),
					);
					for (const nodeResponse of nodeResponses) {
						if (nodeResponse?.nodes) {
							for (const [nodeId, nodeData] of Object.entries(
								nodeResponse.nodes,
							)) {
								nodeDetailsMap[nodeId] = (nodeData as any)?.document;
							}
						}
					}

					for (const set of targetSets) {
						const spec: ComponentSpec = {
							id: set.node_id,
							name: set.name,
							description: set.description || undefined,
						};
						const setNode = nodeDetailsMap[set.node_id];
						const variants = (componentsBySetId.get(set.node_id) || []).map(
							(component: any) => {
								const entry: {
									name: string;
									id: string;
									visualSpec?: VisualSpec;
									visualSpecDelta?: Record<string, any>;
								} = { name: component.name, id: component.node_id };
								if (needsVariantVisuals) {
									const variantNode = setNode?.children?.find(
										(child: any) => child.id === component.node_id,
									);
									const visualSpec = extractVisualSpec(variantNode);
									if (visualSpec) entry.visualSpec = visualSpec;
								}
								return entry;
							},
						);

						if (variants.length > 0) {
							if (needsVariantVisuals) deltaEncodeVariantSpecs(variants);
							spec.variants = variants;
						}
						if (setNode?.componentPropertyDefinitions) {
							spec.properties = setNode.componentPropertyDefinitions;
						}
						if (needsComponentVisuals && setNode?.absoluteBoundingBox) {
							spec.bounds = {
								width: setNode.absoluteBoundingBox.width,
								height: setNode.absoluteBoundingBox.height,
							};
						}
						if (needsComponentVisuals) {
							const visualSpec = extractVisualSpec(setNode);
							if (visualSpec) spec.visualSpec = visualSpec;
						}
						componentSpecs.push(spec);
					}

					for (const component of targetComponents) {
						const spec: ComponentSpec = {
							id: component.node_id,
							name: component.name,
							description: component.description || undefined,
						};
						const node = nodeDetailsMap[component.node_id];
						if (node?.componentPropertyDefinitions) {
							spec.properties = node.componentPropertyDefinitions;
						}
						if (needsComponentVisuals && node?.absoluteBoundingBox) {
							spec.bounds = {
								width: node.absoluteBoundingBox.width,
								height: node.absoluteBoundingBox.height,
							};
						}
						if (needsComponentVisuals) {
							const visualSpec = extractVisualSpec(node);
							if (visualSpec) spec.visualSpec = visualSpec;
						}
						componentSpecs.push(spec);
					}

					// Summary and compact compression always remove image URLs, so avoid
					// rendering them when the requested format cannot return them.
					if (
						includeImages &&
						format === "full" &&
						componentSpecs.length > 0
					) {
						const imageResults = await Promise.all(
							Array.from(
								{ length: Math.ceil(componentSpecs.length / batchSize) },
								(_, batchIndex) => {
									const batch = componentSpecs
										.slice(batchIndex * batchSize, (batchIndex + 1) * batchSize)
										.map((component) => component.id);
									return (async (): Promise<{
										images?: Record<string, string | null>;
										error?: string;
									}> => {
										try {
											const imagesResult = await withTimeout(
												requestApi.getImages(fileKey, batch, {
													scale: 2,
													format: "png",
												}),
												30000,
												`getImages(batch ${batchIndex + 1})`,
											);
											return { images: imagesResult?.images };
										} catch (err) {
											return {
												error: err instanceof Error ? err.message : String(err),
											};
										}
									})();
								},
							),
						);

						for (const result of imageResults) {
							if (result.images) {
								for (const spec of componentSpecs) {
									const url = result.images[spec.id];
									if (url) spec.imageUrl = url;
								}
							}
						}

						const firstImageError = imageResults.find((result) => result.error);
						if (firstImageError?.error) {
							errors.push({
								section: "component_images",
								message: firstImageError.error,
							});
						}
					}

					kit.components = {
						items: componentSpecs,
						summary: {
							totalComponents: componentSpecs.length,
							totalComponentSets: targetSets.length,
						},
					};
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					errors.push({ section: "components", message });
				}
			})(),
		);
	}

	if (include.includes("styles")) {
		sectionTasks.push(
			(async () => {
				try {
					const stylesResponse = await withTimeout(
						requestApi.getStyles(fileKey),
						30000,
						"getStyles",
					);
					const allStyles = stylesResponse?.meta?.styles || [];
					const styleSpecs: StyleSpec[] = allStyles.map((style: any) => ({
						key: style.key,
						name: style.name,
						styleType: style.style_type,
						description: style.description || undefined,
						nodeId: style.node_id,
					}));
					if (format !== "compact" && styleSpecs.length > 0) {
						const resolvedValues = await resolveStyleValues(
							requestApi,
							fileKey,
							styleSpecs,
						);
						for (const style of styleSpecs) {
							if (style.nodeId && resolvedValues.has(style.nodeId)) {
								style.resolvedValue = resolvedValues.get(style.nodeId);
							}
						}
					}
					const stylesByType: Record<string, number> = {};
					for (const style of styleSpecs) {
						stylesByType[style.styleType] =
							(stylesByType[style.styleType] || 0) + 1;
					}
					kit.styles = {
						items: styleSpecs,
						summary: { totalStyles: styleSpecs.length, stylesByType },
					};
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					errors.push({ section: "styles", message });
				}
			})(),
		);
	}

	await Promise.all(sectionTasks);
	// Section work is concurrent, so restore the stable error ordering of the
	// sequential implementation for callers and snapshots.
	const errorOrder = ["tokens", "components", "component_images", "styles"];
	errors.sort(
		(a, b) => errorOrder.indexOf(a.section) - errorOrder.indexOf(b.section),
	);

	if (errors.length > 0) kit.errors = errors;
	const sections: string[] = [];
	if (kit.tokens) {
		sections.push(
			`${kit.tokens.summary.totalVariables} tokens in ${kit.tokens.summary.totalCollections} collections`,
		);
	}
	if (kit.components) {
		sections.push(
			`${kit.components.summary.totalComponents} components (${kit.components.summary.totalComponentSets} sets)`,
		);
	}
	if (kit.styles) sections.push(`${kit.styles.summary.totalStyles} styles`);

	kit.ai_instruction =
		"DESIGN SYSTEM SPECIFICATION — STRICT VISUAL FIDELITY REQUIRED\n\n" +
		`Contains: ${sections.join(", ")}.\n\n` +
		"RULES:\n" +
		"1. ONLY use colors, spacing, and typography values from this data. " +
		"Do NOT invent, guess, or add any visual properties not explicitly present.\n" +
		"2. Map 'visualSpec' directly to CSS:\n" +
		"   - fills[].color → background-color (e.g. #181818)\n" +
		"   - strokes[].color/weight → border (e.g. 1px solid #9747FF)\n" +
		"   - effects[] → box-shadow (type DROP_SHADOW: offset.x offset.y radius spread color)\n" +
		"   - cornerRadius → border-radius\n" +
		"   - layout.mode HORIZONTAL → flex-direction:row, VERTICAL → flex-direction:column\n" +
		"   - layout.paddingTop/Right/Bottom/Left → padding\n" +
		"   - layout.itemSpacing → gap\n" +
		"   - layout.primaryAxisAlign → justify-content, counterAxisAlign → align-items\n" +
		"   - typography → font-family, font-size, font-weight, line-height, letter-spacing\n" +
		"   - Variant specs are delta-encoded: one base variant carries the full visualSpec; " +
		"sibling variants carry 'visualSpecDelta' with ONLY the properties that differ from the base " +
		"(null = property absent on this variant). Merge base visualSpec + visualSpecDelta to get a " +
		"variant's full spec. A variant with neither field is visually identical to the base.\n" +
		"3. Do NOT add decorative elements (colored borders, accents, dividers, gradients) " +
		"unless they appear in the visualSpec data.\n" +
		"4. Use 'imageUrl' screenshots as the visual ground truth. If the screenshot " +
		"shows a simple dark card, do not add colored side borders or other embellishments.\n" +
		"5. Style 'resolvedValue' contains the exact design system colors and typography — " +
		"match these values precisely, do not substitute similar colors.\n" +
		"6. Component 'properties' define the component API (props). " +
		"VARIANT type properties define the visual variants (e.g. Info, Danger, Success). " +
		"BOOLEAN properties toggle features. TEXT properties accept string content.\n" +
		"7. When applying to an existing component library (e.g. shadcn, MUI, Chakra), " +
		"override the library's default theme values with the exact colors, spacing, and " +
		"typography from this specification. Do not blend with library defaults.";

	const sizeKB = calculateSizeKB(kit);
	let compressionLevel: "summary" | "inventory" | "compact" | null = null;
	if (format === "compact") compressionLevel = "compact";
	else if (format === "summary") compressionLevel = "summary";
	if (sizeKB > 500) compressionLevel = "compact";
	else if (
		sizeKB > 200 &&
		(!compressionLevel || compressionLevel === "summary")
	)
		compressionLevel = "inventory";
	else if (sizeKB > 100 && !compressionLevel) compressionLevel = "summary";

	if (!compressionLevel) return kit;
	const compressed = compressKit(kit, compressionLevel);
	const compressedSizeKB = calculateSizeKB(compressed);
	if (sizeKB > 100) {
		compressed.ai_instruction =
			`Response auto-compressed (${compressionLevel}) from ${sizeKB.toFixed(0)}KB to ${compressedSizeKB.toFixed(0)}KB. ` +
			compressed.ai_instruction +
			" For full visual specs of specific components, re-call with specific componentIds and format='full'.";
	}
	return compressed;
}

export function registerDesignSystemTools(
	server: McpServer,
	getFigmaAPI: () => Promise<FigmaAPI>,
	getCurrentUrl: () => string | null,
	variablesCache?: Map<string, { data: any; timestamp: number }>,
	options?: { isRemoteMode?: boolean },
	getDesktopConnector?: () => Promise<any>,
	designSystemCache?: DesignSystemKitCache,
): void {
	server.tool(
		"figma_get_design_system_kit",
		"PREFERRED TOOL for design system extraction — replaces separate figma_get_styles, figma_get_variables, and figma_get_component calls. " +
			"Returns tokens, components, and styles in a single optimized response with adaptive compression for large systems. " +
			"Includes component visual specs (exact colors, padding, typography, layout), rendered screenshots, " +
			"token values per mode (light/dark), and resolved style values. " +
			"Use this instead of calling individual tools to avoid context window overflow. " +
			"Ideal for AI code generation — use visualSpec for pixel-accurate reproduction. " +
			"Variant specs are delta-encoded: the base variant carries the full visualSpec, siblings carry visualSpecDelta with only the properties that differ. " +
			"Tokens/variables are read through the connected Desktop Bridge or cloud relay and work on ANY Figma plan — no Enterprise required. " +
			"If a tokens fetch ever reports the Variables REST API is plan-limited (403), the bridge/relay is the plan-independent path: ensure it's connected and retry rather than abandoning variables.",
		{
			fileKey: z
				.string()
				.optional()
				.describe(
					"Figma file key. If omitted, extracted from the current browser URL.",
				),
			include: z
				.array(z.enum(["tokens", "components", "styles"]))
				.optional()
				.default(["tokens", "components", "styles"])
				.describe("Which sections to include. Defaults to all."),
			componentIds: z
				.array(z.string())
				.optional()
				.describe(
					"Optional list of specific component node IDs to include. If omitted, all published components are returned.",
				),
			includeImages: z
				.boolean()
				.optional()
				.default(false)
				.describe(
					"Include image URLs for components (adds latency). Default false.",
				),
			format: z
				.enum(["full", "summary", "compact"])
				.optional()
				.default("full")
				.describe(
					"'full' returns complete data with visual specs and resolved values. " +
						"'summary' strips variant-level visual specs (medium payload). " +
						"'compact' returns only names, types, and property definitions (smallest payload, best for large design systems). " +
						"Auto-compresses if response exceeds safe size regardless of format setting.",
				),
		},
		async ({ fileKey, include, componentIds, includeImages, format }) => {
			try {
				const api = await getFigmaAPI();

				// Resolve file key
				let resolvedFileKey = fileKey;
				if (!resolvedFileKey) {
					const currentUrl = getCurrentUrl();
					if (currentUrl) {
						resolvedFileKey = extractFileKey(currentUrl) || undefined;
					}
				}

				if (!resolvedFileKey) {
					throw new Error(
						"No file key provided and no Figma file currently open. " +
							"Provide a fileKey parameter or navigate to a Figma file first.",
					);
				}

				const assembled = await assembleDesignSystemKit({
					api,
					fileKey: resolvedFileKey,
					include,
					componentIds,
					includeImages,
					format,
					variablesCache,
					getDesktopConnector,
					designSystemCache,
				});
				return {
					content: [{ type: "text", text: JSON.stringify(assembled) }],
				};
			} catch (error) {
				logger.error({ error }, "Failed to generate design system kit");
				const errorMessage =
					error instanceof Error ? error.message : String(error);

				// Check if it's an auth error
				let parsedError: any = null;
				try {
					parsedError = JSON.parse(errorMessage);
				} catch {
					// Not a JSON error
				}

				if (
					parsedError?.error === "authentication_required" ||
					parsedError?.error === "oauth_error"
				) {
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(parsedError),
							},
						],
						isError: true,
					};
				}

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								error: errorMessage,
								message: "Failed to generate design system kit",
								hint: "Ensure you have a valid Figma file key and the file contains published components/variables.",
							}),
						},
					],
					isError: true,
				};
			}
		},
	);
}
