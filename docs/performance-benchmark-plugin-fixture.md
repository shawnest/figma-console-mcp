# Manual Figma Plugin Performance Benchmark

Slice 4 measures work that deterministic Node benchmarks cannot reproduce: Figma Plugin API calls, page loading, document traversal, structured cloning between the plugin worker and UI iframe, JSON work in the UI, and font loading.

Results are manual and machine-specific. The benchmark mode is disabled during normal plugin operation and is enabled only from the plugin UI's Benchmark panel.

## Controlled fixture

Use the dedicated empty [Benchmark](https://www.figma.com/design/fRMASslPXRlRqMw0jA2wQk/Benchmark?node-id=0-1) Figma file as the host. Identity is recorded in [figma-plugin-host.json](../benchmarks/fixtures/figma-plugin-host.json): file key `fRMASslPXRlRqMw0jA2wQk`, starting page `0:1`. Keep that file (and duplicates of it) for plugin and live MCP checks; do not generate fixtures into product files.

The generator is [figma-plugin-fixture.js](../benchmarks/fixtures/figma-plugin-fixture.js). Duplicate the empty Benchmark file for the tier being prepared, open the Desktop Bridge plugin in that copy, then paste the generator into `figma_execute` after editing `CONFIG`. The generator refuses to run unless the file still has exactly one page and never deletes existing content, so each tier needs its own empty duplicate. Contributors without access to this file can follow the same one-page empty-host procedure in their own account.

| Fixture tier | Variables | Pages | Components created per page | Variants per set |
| --- | ---: | ---: | --- | ---: |
| Small | 10 | 5 | 1 component set, 2 instances, 1 standalone, 3 text nodes | 4 |
| Medium | 100 | 25 | 1 component set, 2 instances, 1 standalone, 3 text nodes | 4 |
| Large | 1,000 | 100 | 1 component set, 2 instances, 1 standalone, 3 text nodes | 4 |
| Stress | 5,000 | 100 | 1 component set, 2 instances, 1 standalone, 3 text nodes | 4 |

The generator creates four variable collections with a Base mode and a Dark mode when the Figma plan allows more than one mode. On Starter/free plans `addMode` is skipped and variables keep a single Base mode so generation can still complete. It also creates component-set variant names using `State` and `Size` axes, instances, standalone components, and text nodes using Inter Regular/Bold where available. It refuses to run unless the file starts with exactly one page and never deletes existing content.

Prepare each tier independently. After generating it, close and reopen the Figma file before measuring if the run should represent a freshly opened file. Do not mix tiers in one result.

## Procedure

1. Build and start the local server (`npm run dev:local` in a separate terminal, or start it through an MCP client), then import or refresh `figma-desktop-bridge/manifest.json` in Figma Desktop.
2. Open the prepared Benchmark duplicate in Figma Desktop (or `figma_navigate` to it) and run the Desktop Bridge plugin. Record the copy's file key from the Benchmark JSON export; only the empty original keeps `fRMASslPXRlRqMw0jA2wQk`.
3. Expand `+`, open `Benchmark`, and enter:
   - `Fixture`: `ds-fixture-v1`;
   - `Desktop`: the Figma Desktop version from the app's About screen;
   - `Variables` and `Pages`: the prepared tier;
   - `File freshly opened`: checked only when the file was reopened immediately before the run.
4. Click `Start`, then `Run sample`. The read-only sample calls the existing `REFRESH_VARIABLES` and `GET_LOCAL_COMPONENTS` handlers and sends a transport-only WebSocket ping when an MCP server is connected.
5. Exercise a representative font path through the normal MCP surface, for example instantiate one fixture component or update a fixture text node. This records unique-font discovery and font loading. Avoid document-mutating calls for the benchmark itself.
6. Click `Export JSON`. The browser download is named `figma-plugin-benchmark-<runId>.json`.

The export includes the active page, editor type, file identity, fixture metadata, Figma Desktop version entered by the operator, whether the file was freshly opened, and raw entries from both realms. Keep the JSON with the fixture tier and machine details; do not compare manual runs across materially different machines without noting the difference.

## Timing entries

Plugin-worker entries include:

- `plugin-code-evaluation-to-ui-ready`;
- `local-variable-retrieval` and `variable-collection-retrieval`;
- `variable-mapping-serialization`;
- `load-all-pages-async`;
- `selection-and-page-listeners-ready` and `document-change-tracking-ready`;
- `component-traversal`;
- `unique-font-discovery` and `font-loading`.

UI and transport entries include:

- `plugin-to-ui-postMessage-receive` and `plugin-to-ui-postMessage-round-trip`;
- `ui-json-encoding` and `ui-json-decoding`;
- `websocket-transit-round-trip`.

Each entry has a `runId`; command-associated entries also carry a `requestId` where one exists. Plugin API stages are measured in the plugin worker, JSON stages in the UI iframe, and WebSocket transit uses a benchmark-only ping/pong handled by the local server. The worker/UI postMessage measurement is explicitly an acknowledgement round trip because the two realms do not promise a shared `performance.now()` origin.

The benchmark marker messages are separate from command messages. They are sent only while capture is enabled, so command result shapes and normal operation are unchanged when the panel is not active.

## Repeating a run

Record the following alongside every exported JSON file:

- fixture version and tier, plus the host file key or duplicate file key;
- Figma Desktop version and editor type;
- plugin version;
- operating system and machine model;
- active page;
- freshly-opened status;
- whether an MCP WebSocket was connected;
- any font families unavailable on that machine.

This is a manual benchmark by design. It is not part of CI and must not be treated as a stable regression threshold until enough controlled runs exist for the target machine and Figma Desktop version.

## Live MCP checks

The same empty host is the safe file for live MCP/plugin exercises that Node mocks cannot cover: `figma_navigate` to the URL, `figma_execute` for fixture generation, then read-only tools such as `figma_get_variables` and `figma_get_file_data`. Keep writes inside this file or a duplicate of it.

Startup, WebSocket transport, and design-system kit benchmarks stay on generated fixtures and do not call this file. CI must not depend on it.
