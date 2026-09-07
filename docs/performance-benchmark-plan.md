# Performance Benchmark Plan

## Purpose

Build a repeatable performance measurement system before optimizing the Figma Desktop Bridge plugin or MCP server. The suite must distinguish MCP startup, protocol/catalog overhead, WebSocket transport, server-side processing, Figma REST calls, and work performed inside the Figma plugin.

The result should let us answer three questions for every proposed change:

1. What became faster or smaller?
2. By how much at the median and at the slow end?
3. Did another part of the system regress?

## Principles

- Establish and commit baselines before performance changes.
- Prefer end-to-end vertical slices over building a large benchmark framework upfront.
- Record machine-readable results as well as a short human-readable summary.
- Report distributions (`median`, `p95`, and `p99` where useful), not only averages.
- Separate cold-start, warm-start, cache-hit, and cache-miss scenarios.
- Keep deterministic synthetic benchmarks in CI; run Figma-dependent benchmarks manually on a controlled fixture.
- Record environment metadata with every run: commit, OS, architecture, Node version, package version, CPU, memory, and timestamp.
- Treat measurement overhead explicitly. Instrumented production paths should be disabled by default or sufficiently cheap to leave enabled.

## Metrics and terminology

| Metric | Definition |
| --- | --- |
| Wall time | Elapsed time observed by the caller |
| CPU time | Process CPU used during a scenario, where available |
| Ready time | Child-process spawn until the MCP responds to `initialize` |
| Round-trip time | Request send until correlated response is received |
| Throughput | Successfully completed operations per second |
| Payload bytes | UTF-8 or binary bytes crossing a boundary |
| Heap delta | JavaScript heap growth during a scenario |
| Peak RSS | Maximum resident process memory observed during a scenario |
| p50/median | Typical run duration |
| p95/p99 | Slow-tail run duration |

Unless a scenario says otherwise, run one untimed warm-up followed by at least 20 measured iterations. Do not compare results collected with different benchmark fixtures or materially different machines.

## Result format

Each benchmark writes one JSON document that follows a shared envelope:

```json
{
  "schemaVersion": 1,
  "suite": "mcp-startup",
  "scenario": "initialize-and-list-tools",
  "environment": {
    "commit": "abc1234",
    "os": "win32",
    "arch": "x64",
    "node": "v22.0.0",
    "cpu": "CPU model",
    "memoryMb": 32768
  },
  "configuration": {
    "warmupRuns": 1,
    "measuredRuns": 20
  },
  "metrics": {
    "medianMs": 574,
    "p95Ms": 640,
    "payloadBytes": 161649,
    "peakRssMb": 98
  },
  "samples": []
}
```

Raw samples should be retained so statistics can be recomputed. A formatter should produce a compact Markdown table for pull requests and local review.

## Slice 1: MCP startup and catalog baseline

### Outcome

One command measures the cost of starting the local MCP server, completing the MCP handshake, and retrieving its tool catalog. This immediately creates useful coverage for tool-profile and import/startup work.

### Deliverables

- Add `benchmarks/mcp-startup.mjs`.
- Spawn `dist/local.js` through the MCP SDK rather than searching logs for readiness.
- Measure:
  - process spawn to successful `initialize`;
  - `tools/list` wall time;
  - tool count;
  - serialized tool-catalog bytes;
  - approximate catalog tokens, clearly labelled as an estimate;
  - child-process idle RSS and heap where the platform permits it.
- Add `npm run benchmark:startup`.
- Add a small shared statistics module for median and percentiles.
- Write results to an ignored timestamped directory, with an explicit command for promoting a chosen run to a committed baseline.
- Document the existing observed reference values: about 574 ms to readiness, 121 tools, and 161,649 catalog bytes on the initial Windows measurement. These are reference observations, not regression thresholds.

### Acceptance criteria

- The command exits cleanly and leaves no MCP or WebSocket process running.
- Twenty-run output includes raw samples, median, and p95.
- A failure to initialize produces a non-zero exit and useful diagnostics.
- Running the suite twice on an idle machine produces reasonably similar medians; record the observed variance instead of choosing an arbitrary tolerance.

### Enables

- Measuring tool profiles or shorter descriptions.
- Measuring lazy imports and startup ordering.
- Detecting accidental catalog growth.

## Slice 2: WebSocket bridge round-trip benchmark

### Outcome

A simulated plugin client measures the local bridge independently of Figma, including payload encoding and request correlation.

### Deliverables

- Add `benchmarks/websocket-transport.mjs` using a real `FigmaWebSocketServer` on an OS-assigned or verified-free port.
- Connect a mock WebSocket plugin, complete the `FILE_INFO` handshake, and echo correlated command responses.
- Include scenarios for:
  - sequential tiny requests;
  - bounded concurrent requests at concurrency 2, 8, and 32;
  - 100 KB, 1 MB, and 10 MB JSON responses;
  - a representative variables response fixture;
  - timeout and disconnect cleanup.
- Measure median/p95/p99 round-trip time, throughput, serialized bytes, heap delta, and peak RSS.
- Add `npm run benchmark:transport`.

### Acceptance criteria

- No real Figma installation or network connection is required.
- The benchmark verifies response correctness before recording timing.
- It detects unresolved pending requests or open handles at shutdown.
- Large-payload scenarios do not print their payloads to stdout or logs.

### Enables

- Measuring serialization changes.
- Measuring duplicate variable transfers.
- Measuring concurrency and pending-request changes.

## Slice 3: Design-system extraction benchmark with controlled I/O

### Outcome

The design-system kit can be benchmarked with realistic data and deterministic REST latency without calling Figma.

### Deliverables

- Extract or expose the design-system-kit assembly path so it can be invoked without an MCP text-protocol round trip while retaining one end-to-end MCP scenario.
- Add generated or sanitized fixtures representing approximately:
  - 10 components and 100 variables;
  - 100 components and 1,000 variables;
  - 500 components and 5,000 variables;
  - component sets with many variants.
- Implement a fake `FigmaAPI` that records requests and can apply fixed or seeded latency.
- Include scenarios for:
  - tokens only;
  - components only;
  - styles only;
  - full kit;
  - full kit with images;
  - cache miss and cache hit;
  - compact, summary, and full responses.
- Measure wall time, CPU time, REST request count, maximum observed concurrency, response bytes, heap delta, and peak RSS.
- Add `npm run benchmark:design-system`.

### Acceptance criteria

- Fixtures and artificial latency are deterministic from a recorded seed.
- Benchmarks fail if output counts or essential fields are incorrect.
- Results expose whether time was spent waiting for simulated I/O or doing local processing.
- The suite can demonstrate the current sequential top-level behavior before it is changed.

### Enables

- Measuring parallel tokens/components/styles work.
- Choosing a safe REST concurrency limit.
- Measuring component indexing versus repeated scans.
- Measuring component/style caching.

## Slice 4: Plugin instrumentation and real-Figma fixture

### Outcome

We can measure the work that mocks cannot reproduce: Figma Plugin API calls, page loading, structured cloning across `postMessage`, document traversal, and font loading.

### Deliverables

- Add an opt-in benchmark mode to the Desktop Bridge, disabled during normal operation.
- Use `performance.now()` around named stages and return structured timing entries rather than relying on console timestamps.
- Instrument at least:
  - plugin code evaluation to UI ready;
  - `loadAllPagesAsync()`;
  - local-variable and collection retrieval;
  - variable mapping/serialization;
  - plugin-to-UI `postMessage` transit;
  - UI JSON encoding;
  - WebSocket transit;
  - component traversal;
  - unique-font discovery and font loading.
- Add a benchmark command or plugin UI action that exports results as JSON.
- Create and document a controlled Figma fixture with fixed tiers:
  - dedicated empty host file [Benchmark](https://www.figma.com/design/fRMASslPXRlRqMw0jA2wQk/Benchmark?node-id=0-1) (`fRMASslPXRlRqMw0jA2wQk`);
  - variable counts: 10, 100, 1,000, and 5,000;
  - page counts: 5, 25, and 100;
  - representative component sets, instances, and text nodes.
- Record the Figma Desktop version, editor type, fixture version, active page, and whether the file was freshly opened.

### Acceptance criteria

- Benchmark mode does not change command results.
- Every timing entry has a request/run ID so concurrent activity cannot be mixed.
- Results distinguish Plugin API duration from serialization and transport duration.
- The documented procedure can be repeated by another developer without private files.
- Results are explicitly marked as manual and machine-specific.

### Enables

- Measuring lazy variable loading.
- Measuring deferred all-page loading.
- Measuring parallel or cached font loading.
- Confirming that synthetic improvements matter inside Figma.

## Slice 5: Comparison and regression reporting

### Outcome

Any branch can be compared against a stored baseline with a concise report and no manual spreadsheet work.

### Deliverables

- Add `benchmarks/compare.mjs` to compare two result directories or files.
- Report absolute and percentage changes for each shared metric.
- Highlight improvements, regressions, incompatible fixture/configuration changes, and missing scenarios.
- Add `npm run benchmark` for the deterministic suites and `npm run benchmark:compare` for comparison.
- Commit representative baseline JSON with raw samples, or commit a compact baseline plus an external/raw-results policy if repository size becomes material.
- Document how to collect `before` and `after` results from the same checkout environment.

### Acceptance criteria

- Comparing a result with itself reports no meaningful change.
- The comparator refuses to present a percentage comparison when fixture versions or critical configuration differ.
- Markdown output is compact enough to paste into a pull request.
- Baselines are updated deliberately, never automatically during a normal test run.

### Enables

- Evidence-based performance pull requests.
- Historical tracking of startup, payload, and extraction costs.

## Slice 6: CI smoke benchmarks and lifecycle hygiene

### Outcome

CI detects major performance regressions and resource leaks without becoming flaky or adding excessive runtime.

### Deliverables

- Run short deterministic startup, catalog, transport, and design-system smoke scenarios in CI.
- Upload full JSON results as build artifacts.
- Initially operate in report-only mode while enough runs are collected to understand runner variance.
- Add correctness-oriented hard limits immediately where variance is irrelevant, for example:
  - catalog byte ceiling;
  - request-count ceiling;
  - no unresolved pending requests;
  - clean process and socket shutdown;
  - maximum output payload size for compact scenarios.
- After collecting sufficient CI history, introduce conservative time and memory regression thresholds.
- Remove the need for Jest `forceExit` by finding and closing remaining handles; keep this work separate from benchmark numbers so forced termination cannot make resource results appear healthy.

### Acceptance criteria

- Smoke benchmarks add an agreed, bounded amount of CI time.
- CI artifacts contain environment metadata and raw samples.
- Timing thresholds are based on observed CI variance and documented rationale.
- A deliberately leaked socket or pending request fails the lifecycle check.

## Recommended execution order

Implement slices in order. Slices 1 and 2 establish the harness and lifecycle discipline. Slice 3 provides deterministic evidence for server-side optimization. Slice 4 adds the essential real-Figma view. Slices 5 and 6 turn those measurements into a sustainable workflow.

Do not optimize the measured paths while creating their initial baselines. If a small refactor is required to make code benchmarkable, keep behavior unchanged and validate it with the existing test suite before recording the baseline.

## Initial optimization experiments after baselining

Once the relevant slices exist, test these changes independently so their effects remain attributable:

1. Configurable MCP tool profiles.
2. Lazy variable snapshot creation and elimination of duplicate refresh transfers.
3. Immediate lightweight listeners with deferred `loadAllPagesAsync()`.
4. Parallel top-level design-system sections with bounded REST concurrency.
5. Indexed component-set and variant lookup.
6. Component/style result caching.
7. Synchronous or iterative CPU-only relationship traversal.
8. Unique-font parallel loading and plugin-lifetime font caching.
9. Lower-frequency connected-state discovery and UI reconciliation.

For each experiment, collect the applicable baseline and candidate results on the same machine, run the full correctness suite, and include both performance wins and regressions in the change report.

## Definition of done

- `npm run benchmark` produces deterministic startup, transport, design-system, and plugin-startup results.
- The benchmark suite validates output correctness as well as timing.
- A documented manual procedure produces real-Figma plugin results.
- Results can be compared automatically and summarized in Markdown.
- CI preserves benchmark artifacts and enforces stable, low-variance resource limits.
- Every proposed performance optimization can name the scenario and metric that demonstrates its effect.
