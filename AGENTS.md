# Agent instructions

## Repository conventions

- Preserve unrelated working-tree changes.
- Use `apply_patch` for source and documentation edits.
- Run the narrowest relevant tests first, then broader checks when the change warrants it.
- Do not commit benchmark result directories unless a result is deliberately being promoted as a baseline.

## Performance benchmarking

Use the deterministic Node-based benchmarks for performance work. They do not require Figma Desktop:

```sh
npm run benchmark:startup       # MCP spawn, initialize, and tools/list
npm run benchmark:transport     # WebSocket bridge round trips and lifecycle cleanup
npm run benchmark:design-system # design-system kit assembly with generated fixtures
npm run benchmark:plugin-startup # plugin worker eval, listener ready time, deferred all-page loading
npm run benchmark               # all deterministic suites
npm run benchmark:smoke         # fast correctness/lifecycle smoke checks
```

Normal benchmark runs use one warm-up and 20 measured iterations. They write raw JSON results to the ignored `benchmarks/results/<timestamp>/` directory and print a Markdown summary. Use reduced runs only for development diagnostics, not for comparing changes.

For a before/after experiment:

1. Keep the machine as idle as practical and use the same fixture, Node version, and benchmark flags.
2. Run the benchmark before editing and record its result directory.
3. Make one focused change, rebuild, and run the identical benchmark again.
4. Compare the two result directories:

   ```sh
   npm run benchmark:compare -- \
     benchmarks/results/<before-timestamp> \
     benchmarks/results/<after-timestamp>
   ```

5. Review median and p95 wall time first, then CPU, memory, payload size, REST request count, maximum concurrency, and correctness fields. A faster result is not acceptable if request counts, response shape, lifecycle cleanup, or deterministic gates regress.

The comparator reports changes as diagnostic when machine, fixture, or critical configuration differs. Do not compare deterministic Node results with manual real-Figma plugin measurements.

### Real-Figma fixture (not CI)

CI never opens Figma. GitHub Actions and `npm run benchmark:smoke` stay on synthetic Node suites. Plugin API, page loading, fonts, and worker/UI/`postMessage` timings are manual and machine-specific.

Use the dedicated [Benchmark](https://www.figma.com/design/fRMASslPXRlRqMw0jA2wQk/Benchmark?node-id=0-1) file (`fRMASslPXRlRqMw0jA2wQk`; identity in `benchmarks/fixtures/figma-plugin-host.json`). Do not generate fixtures into product files. The generator (`benchmarks/fixtures/figma-plugin-fixture.js`) requires exactly one page and never deletes existing content, so duplicate the host before each new tier. Start with Small (10 variables, 5 pages); Medium is the first real baseline. On Starter/free plans Dark mode is omitted (one mode per collection).

The Benchmark panel exists only on **Figma Desktop Bridge (local)** from this repo (`figma-desktop-bridge/manifest.json`, also copied to `~/.figma-console-mcp/plugin-local/`). The published plugin at `~/.figma-console-mcp/plugin/` has no Benchmark UI. Import the local manifest, run it in the fixture file, then `+` → `Benchmark` → Start → Run sample → Export JSON. Full procedure: `docs/performance-benchmark-plugin-fixture.md`.

Live MCP checks (`figma_navigate`, `figma_execute`, `figma_get_variables`, `figma_get_file_data`) may use the same file without the Benchmark panel. Do not add CI jobs that depend on this file or Figma Desktop.

## Baselines and CI

Baselines are promoted explicitly and should be reviewed separately from optimization code:

```sh
node benchmarks/design-system.mjs \
  --promote benchmarks/results/<timestamp>/design-system.json
```

Use the corresponding startup or transport script for those suites. Read `benchmarks/baselines/README.md` before replacing a committed baseline.

CI runs `npm run benchmark:smoke`. It is report-only for timing and memory; active gates cover startup catalog size, design-system request/response limits, transport cleanup, lifecycle guards, and plugin-startup page-load deferral. It does not use Figma Desktop or the Benchmark file. Run the smoke suite locally for changes affecting startup, WebSocket handling, serialization, plugin listeners, or design-system assembly.

For full benchmark details, see `benchmarks/README.md` and `docs/performance-benchmark-plan.md`.
