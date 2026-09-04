/**
 * Return the median of a non-empty array of finite numbers.
 */
export function median(values) {
	return percentile(values, 50);
}

/**
 * Compute a percentile using linear interpolation between adjacent ranks.
 */
export function percentile(values, percentileValue) {
	if (!Array.isArray(values) || values.length === 0) {
		throw new TypeError("percentile requires at least one value");
	}
	if (!values.every(Number.isFinite)) {
		throw new TypeError("percentile values must all be finite numbers");
	}
	if (!Number.isFinite(percentileValue) || percentileValue < 0 || percentileValue > 100) {
		throw new RangeError("percentile must be between 0 and 100");
	}

	const sorted = [...values].sort((a, b) => a - b);
	const rank = (percentileValue / 100) * (sorted.length - 1);
	const lowerIndex = Math.floor(rank);
	const upperIndex = Math.ceil(rank);
	const weight = rank - lowerIndex;

	return sorted[lowerIndex] + (sorted[upperIndex] - sorted[lowerIndex]) * weight;
}

/**
 * Statistics shared by benchmark suites. Standard deviation is population SD.
 */
export function summarize(values) {
	if (!Array.isArray(values) || values.length === 0) {
		throw new TypeError("summarize requires at least one value");
	}

	const average = values.reduce((sum, value) => sum + value, 0) / values.length;
	const variance =
		values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length;
	const standardDeviation = Math.sqrt(variance);

	return {
		median: median(values),
		p95: percentile(values, 95),
		p99: percentile(values, 99),
		min: Math.min(...values),
		max: Math.max(...values),
		mean: average,
		standardDeviation,
		coefficientOfVariation:
			average === 0 ? 0 : standardDeviation / average,
	};
}
