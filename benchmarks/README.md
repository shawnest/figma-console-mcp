# Performance benchmarks

## MCP startup and catalog

Build the local server, perform one warm-up, and collect 20 measured runs:

```sh
npm run benchmark:startup
```

Results are written beneath `benchmarks/results/<timestamp>/`. That directory is ignored by Git. Each JSON result contains environment metadata, raw samples, median, p95, p99, standard deviation, and coefficient of variation. The console also prints a compact Markdown summary.

Use `--warmup-runs` and `--runs` for diagnostic runs. Runs intended for comparison should use the default configuration:

```sh
node benchmarks/mcp-startup.mjs --warmup-runs 0 --runs 2
```

The benchmark always targets `dist/local.js` unless `--server-path` is supplied. The override is useful for failure-path checks or explicitly comparing another built entrypoint, and is recorded in the result configuration.

Promoting a result is a separate, explicit operation. It validates the result envelope and copies the selected file to `benchmarks/baselines/mcp-startup.json`, where it can be reviewed and committed:

```sh
node benchmarks/mcp-startup.mjs --promote benchmarks/results/<timestamp>/mcp-startup.json
```

Catalog bytes are the UTF-8 byte length of `JSON.stringify(tools)`. The token figure is deliberately labelled as an estimate and uses `ceil(bytes / 4)`; it is not output from a model-specific tokenizer.

Child idle RSS is sampled using the operating system after `tools/list`. V8 heap usage is reported as unavailable because a normal MCP stdio child does not expose it without adding intrusive instrumentation to the measured server.

### Initial reference observation

The initial Windows observation made before this suite was approximately 574 ms to initialize, 121 tools, and 161,649 serialized catalog bytes. These values are machine-specific reference observations, not regression thresholds.

During initial suite validation on 2026-09-04, two consecutive default runs on the same Windows machine produced initialization medians of 495.04 ms and 516.32 ms. The second median was 4.30% higher than the first. Both runs reported 121 tools, 161,639 catalog bytes, and child idle RSS medians within 0.03 MiB. This is an observed variance sample, not a tolerance or regression threshold.

## WebSocket bridge transport

Build the local server and run the deterministic transport matrix without Figma:

```sh
npm run benchmark:transport
```

The suite starts a real `FigmaWebSocketServer` on an OS-assigned port and connects a mock plugin through the normal `FILE_INFO` handshake. It covers sequential and bounded-concurrent tiny messages, exact 100 KiB/1 MiB/10 MiB JSON responses, and a deterministic representative variables fixture. Every response is checked for content and request correlation before its timing sample is retained.

Each scenario records raw round-trip samples, p50/p95/p99, throughput, request and response bytes, CPU time, heap delta, and peak process RSS. Payload bodies are never printed. The final lifecycle checks exercise timeout and disconnect rejection, pending-request cleanup, recovery after reconnection, server state cleanup, and release of the listening port.

For a short diagnostic run:

```sh
npm run build:local
node --expose-gc benchmarks/websocket-transport.mjs --warmup-runs 0 --runs 5
```

Concurrent scenarios always execute at least four operations per worker, so their operation count can exceed `--runs`. Promote a deliberately selected result with:

```sh
node benchmarks/websocket-transport.mjs --promote benchmarks/results/<timestamp>/websocket-transport.json
```

## Design-system kit assembly

Build the local server and run the deterministic design-system matrix without Figma:

```sh
npm run benchmark:design-system
```

The suite uses generated fixtures for 10/100/500 components and 100/1,000/5,000 variables. It measures tokens, components, styles, full kits, image-inclusive kits, compact/summary/full formats, variable cache miss/hit, and one MCP client/server round trip. Direct scenarios call the extracted assembly function; the MCP scenario uses the registered public tool through the SDK's in-memory transport.

The fake Figma API records REST request count, maximum observed concurrency, deterministic fixed or seeded latency, and the union of simulated wait intervals. `localProcessingMs` is wall time minus that interval union, so the report makes the current sequential top-level orchestration visible without contacting Figma.

Use a short diagnostic run while developing the benchmark:

```sh
npm run build:local
node --expose-gc benchmarks/design-system.mjs --warmup-runs 0 --runs 1 --latency-mode fixed --latency-ms 1
```

The default is one warm-up and 20 measured runs per scenario. Results are written to the ignored `benchmarks/results/<timestamp>/design-system.json`; promote a deliberately selected result with:

```sh
node benchmarks/design-system.mjs --promote benchmarks/results/<timestamp>/design-system.json
```

## Manual Figma Plugin instrumentation

Slice 4 is intentionally manual and machine-specific. The bridge's Benchmark panel is opt-in and exports structured Plugin worker, UI iframe, postMessage, JSON, font, and WebSocket timing entries as a downloaded JSON file. It does not run in CI or change normal command result shapes.

Follow [the controlled fixture procedure](../docs/performance-benchmark-plugin-fixture.md). The fixture generator is [figma-plugin-fixture.js](fixtures/figma-plugin-fixture.js); use it in a fresh Figma file for the 10/100/1,000/5,000-variable and 5/25/100-page tiers, then reopen the file when measuring a freshly-opened run.

The UI sample runs the existing variable refresh and local-component traversal handlers, then sends a benchmark-only WebSocket ping if an MCP server is connected. Exercise one normal text/component operation as described in the procedure to capture unique-font discovery and font loading before exporting. Fill in the Figma Desktop version, fixture tier, and freshly-opened flag in the panel so the JSON remains repeatable and attributable.

## Comparison and baselines

Run all deterministic suites with:

```sh
npm run benchmark
```

Each suite creates its own timestamped result directory. To compare runs from the same machine, pass either the individual JSON files or directories containing one result per suite:

```sh
npm run benchmark:compare -- benchmarks/results/<before-timestamp> benchmarks/results/<after-timestamp>
node benchmarks/compare.mjs --before before --after after --output comparison.md
```

The report compares every shared numeric metric, including distribution summaries, and shows absolute and percentage changes. Lower wall time, CPU, memory, payload, request count, and similar resource metrics are treated as improvements; throughput is treated as higher-is-better. Percentage changes are withheld when fixture versions, machine details, or critical configuration differ. Warm-up/measured run counts, commit, dirty state, and timestamp are recorded metadata and do not block a comparison.

Before/after collection should use the same built checkout environment: build once, keep the machine idle, run the `before` suite, make the code change, rebuild, and run the `after` suite with the same benchmark flags and fixture settings. Do not compare a real-Figma manual result with a deterministic Node result.

Promote a selected result explicitly; normal benchmark commands never update baselines:

```sh
node benchmarks/mcp-startup.mjs --promote benchmarks/results/<timestamp>/mcp-startup.json
node benchmarks/websocket-transport.mjs --promote benchmarks/results/<timestamp>/websocket-transport.json
node benchmarks/design-system.mjs --promote benchmarks/results/<timestamp>/design-system.json
```

Committed baseline policy is documented in [benchmarks/baselines/README.md](baselines/README.md). Baselines are deliberately promoted representative results; raw timestamped results remain local unless a raw run is specifically needed for audit or historical analysis.

## CI smoke and lifecycle checks

Run the bounded smoke suite locally with:

```sh
npm run benchmark:smoke
```

The GitHub Actions workflow at `.github/workflows/benchmark-smoke.yml` runs the same command on pushes, pull requests, and manual dispatches. It builds once, performs one measured run per deterministic suite, and uploads every JSON result as an artifact, including results from a failed run when available.

CI is report-only for timing and memory until runner variance has been observed. Deterministic gates are active immediately:

- startup catalog output must be at most 200,000 UTF-8 bytes;
- each design-system scenario may make at most 64 REST requests;
- compact design-system responses must be at most 100 KiB;
- the transport suite must leave no pending requests, release its port, and clean up the server, sockets, and supported active handles.

The smoke result configuration records these limits. A failed gate exits non-zero; timing and memory remain diagnostic fields until a documented CI history supports conservative thresholds.

The smoke suite also runs `benchmarks/lifecycle-guards.test.mjs`. Its negative cases intentionally leave a pending command and an unidentified WebSocket open, verify that the lifecycle guards reject both states, and then clean up the resources. Run that test directly with:

```sh
npm run benchmark:lifecycle-test
```
