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

## Baselines and CI

Baselines are promoted explicitly and should be reviewed separately from optimization code:

```sh
node benchmarks/design-system.mjs \
  --promote benchmarks/results/<timestamp>/design-system.json
```

Use the corresponding startup or transport script for those suites. Read `benchmarks/baselines/README.md` before replacing a committed baseline.

CI runs `npm run benchmark:smoke`. It is report-only for timing and memory; active gates cover startup catalog size, design-system request/response limits, transport cleanup, and lifecycle guards. Run the smoke suite locally for changes affecting startup, WebSocket handling, serialization, or design-system assembly.

For full benchmark details, see `benchmarks/README.md` and `docs/performance-benchmark-plan.md`.
