# Performance benchmarks

## MCP startup and catalog

Build the local server, perform one warm-up, and collect 20 measured runs:

```sh
npm run benchmark:startup
```

Results are written beneath `benchmarks/results/<timestamp>/`. That directory is ignored by Git. Each JSON result contains environment metadata, raw samples, median, p95, p99, standard deviation, and coefficient of variation. The console also prints a compact Markdown summary.

Use `--warmup-runs` and `--runs` for diagnostic runs. Runs intended for comparison should use the default configuration:

```sh
npm run benchmark:startup -- --warmup-runs 0 --runs 2
```

Promoting a result is a separate, explicit operation. It validates the result envelope and copies the selected file to `benchmarks/baselines/mcp-startup.json`, where it can be reviewed and committed:

```sh
npm run benchmark:startup -- --promote benchmarks/results/<timestamp>/mcp-startup.json
```

Catalog bytes are the UTF-8 byte length of `JSON.stringify(tools)`. The token figure is deliberately labelled as an estimate and uses `ceil(bytes / 4)`; it is not output from a model-specific tokenizer.

Child idle RSS is sampled using the operating system after `tools/list`. V8 heap usage is reported as unavailable because a normal MCP stdio child does not expose it without adding intrusive instrumentation to the measured server.

### Initial reference observation

The initial Windows observation made before this suite was approximately 574 ms to initialize, 121 tools, and 161,649 serialized catalog bytes. These values are machine-specific reference observations, not regression thresholds.
