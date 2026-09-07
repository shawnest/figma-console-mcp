# Performance Open Fixes

This backlog contains only performance findings that remain open or incomplete after the design-system extraction work. Complete each item as an isolated before/after experiment so its effect remains attributable.

For every item:

1. Build the current branch.
2. Run the named benchmark with its default one warm-up and 20 measured iterations.
3. Save the result directory.
4. Make one focused change.
5. Rebuild and run the identical benchmark.
6. Compare the result directories with `npm run benchmark:compare`.
7. Run the specified correctness checks.

Do not promote a new baseline until the optimization and its measurement have been reviewed separately.

## Priority 0: Plugin startup

### PERF-01: Lazy-load the variable snapshot

**Status:** Implemented; manual Figma measurement pending  
**Expected impact:** High for variable-heavy files  
**Primary metric:** Fresh plugin startup time and bytes transferred before the first command

The plugin now keeps the variable snapshot cold until a variable command requests it. The plugin worker owns one cached snapshot and the iframe only keeps a relay copy for connected clients.

Implementation checklist:

- [x] Move the initial variable retrieval in `figma-desktop-bridge/code.js` behind an explicit request.
- [x] Keep one plugin-lifetime cached snapshot after the first successful retrieval.
- [x] Add an in-flight promise so simultaneous initial requests share one Plugin API read.
- [x] Make `GET_VARIABLES_DATA` trigger the lazy read when no snapshot exists.
- [x] Preserve the empty variables response for FigJam and Slides.
- [x] Invalidate or replace the snapshot after successful variable writes.
- [x] Ensure a failed first read can be retried.
- [x] Update plugin documentation that currently describes an eager snapshot.

Measurement:

- Use the manual Figma fixture at the 10, 100, 1,000, and 5,000-variable tiers.
- Compare freshly-opened plugin initialization before any MCP variable command.
- Then measure the first variable request and a cached repeat request separately.
- Record Plugin API time, mapping time, `postMessage` time, WebSocket bytes, and total request latency.

Correctness checks:

- Run the variable, token, and WebSocket bridge tests.
- Verify multiple connected local MCP servers receive correct data.
- Verify `refreshCache` still forces a live Plugin API read.

Done when:

- Opening the plugin performs no local-variable or collection API call in Figma/Design mode.
- Concurrent first reads perform exactly one variable retrieval.
- Cached repeats perform no Plugin API retrieval.
- Variable writes cannot leave a stale snapshot visible.

### PERF-02: Defer all-page loading and register lightweight listeners immediately

**Status:** Implemented; manual Figma measurement pending  
**Expected impact:** High for files with many or large pages  
**Primary metric:** Fresh plugin ready time across the 5/25/100-page tiers

The plugin now registers `selectionchange` and `currentpagechange` during worker evaluation. `figma.loadAllPagesAsync()` and `documentchange` stay behind `__ensureDocumentChangeTracking()`.

Activation point: the first local or cloud WebSocket connection. The iframe sends `ENSURE_DOCUMENT_CHANGE_TRACKING` from `initializeConnection` and does not wait for all-page loading before `FILE_INFO`. Selection and page listeners stay on the default startup path.

Implementation checklist:

- [x] Register `selectionchange` immediately.
- [x] Register `currentpagechange` immediately.
- [x] Isolate `documentchange` setup behind a single idempotent initializer.
- [x] Trigger all-page loading only when change tracking is needed.
- [x] Decide and document the activation point: first server connection, first change-history request, or explicit capability enablement.
- [x] Coalesce concurrent activation attempts.
- [x] Report activation failure without disabling selection/page tracking.
- [x] Confirm that all document-change functionality remains available after activation.

Measurement:

- Run `npm run benchmark:plugin-startup` for the 5/25/100-page simulated delays.
- Use the manual Figma fixture at 5, 25, and 100 pages for real Plugin API confirmation.
- Measure code evaluation to UI ready, WebSocket connected, selection listener ready, and all-page loading separately.
- Exercise selection changes before and during deferred page loading.

Correctness checks:

- Run `tests/plugin-document-change-tracking.test.ts` and the WebSocket bridge tests.
- Verify selection and current-page state immediately after startup.
- Verify document changes still invalidate the correct file cache after activation.
- Verify repeated activation does not add duplicate listeners.

Done when:

- Selection and page listeners do not wait for `loadAllPagesAsync()`.
- All-page loading is absent from the default no-change-tracking startup path.
- Change tracking can be activated once and remains behaviorally compatible.

### PERF-03: Eliminate the duplicate variable refresh payload

**Status:** Open  
**Expected impact:** Medium to high for large variable sets  
**Primary metric:** WebSocket bytes and refresh latency at the 1,000/5,000-variable tiers

`REFRESH_VARIABLES` currently emits the complete snapshot both as an unsolicited `VARIABLES_DATA` event and inside `REFRESH_VARIABLES_RESULT`.

Implementation checklist:

- [ ] Choose one authoritative full-data transfer for the requesting server.
- [ ] Keep other connected servers' caches coherent without sending the same full payload twice to the requester.
- [ ] Consider a lightweight invalidation/version event for non-requesting servers.
- [ ] Preserve request correlation and existing response fields.
- [ ] Add byte-count assertions to the representative variables transport scenario.

Measurement:

- Extend the transport benchmark with a refresh flow and two simulated server connections.
- Record total encoded bytes per connection, serialization count, and round-trip time.

Correctness checks:

- Verify requester and non-requester snapshots converge.
- Verify local multi-instance and cloud single-relay behavior.
- Run WebSocket, variable, and token tests.

Done when:

- The requester receives the full refreshed snapshot exactly once.
- Other connections remain coherent.
- Refresh response shape remains compatible or has a documented migration.

## Priority 1: MCP discovery and startup

### PERF-04: Add configurable tool profiles

**Status:** Open  
**Expected impact:** High for client initialization and model context usage  
**Primary metric:** Tool count, catalog bytes, and estimated catalog tokens

The local server still advertises 121 tools in a 161,639-byte catalog, approximately 40,410 tokens by the benchmark's byte-based estimate.

Implementation checklist:

- [ ] Define profiles such as `core`, `write`, `design-system`, `figjam`, `slides`, `apps`, and `all`.
- [ ] Define a backward-compatible default explicitly.
- [ ] Add an environment/config option for selecting one or more profiles.
- [ ] Keep status, diagnostics, and reconnection tools in every usable profile.
- [ ] Prevent duplicate registration when profiles overlap.
- [ ] Make active profiles visible through status/diagnostics.
- [ ] Document profile contents and configuration examples.
- [ ] Add catalog snapshots or assertions per profile.

Measurement:

- Run `npm run benchmark:startup` for `all`, the default profile, and each proposed focused profile.
- Compare initialize time, `tools/list` time, catalog bytes, estimated tokens, and idle RSS.

Correctness checks:

- Verify every existing tool remains available under `all`.
- Verify profile composition and overlap behavior.
- Verify remote/local registration remains intentionally aligned where applicable.

Done when:

- Focused profiles materially reduce catalog bytes.
- `all` preserves the current 121-tool catalog behavior.
- Missing-profile errors are actionable and deterministic.

### PERF-05: Move nonessential synchronous work off the local MCP critical path

**Status:** Open  
**Expected impact:** Medium; platform-dependent  
**Primary metric:** Spawn-to-initialize median and p95

Plugin-file copying and port cleanup currently run before stdio initialization. They use synchronous filesystem and process operations.

Implementation checklist:

- [ ] Measure each startup stage before restructuring it.
- [ ] Avoid copying unchanged plugin files; compare a version marker, size/hash, or modification metadata first.
- [ ] Move nonessential plugin directory synchronization after MCP transport readiness where safe.
- [ ] Use async cleanup variants when cleanup must run while the server can receive requests.
- [ ] Keep port binding correctness and orphan safety unchanged.
- [ ] Ensure background startup work cannot produce unhandled rejections.

Measurement:

- Extend the startup benchmark with stage timings if they can be collected without materially altering the measured path.
- Test no stale files, unchanged files, changed plugin files, and occupied fallback ports.
- Run on Windows and at least one macOS/Linux environment before claiming a general improvement.

Correctness checks:

- Run port-discovery, plugin-version, startup, and lifecycle tests.
- Verify no child process or port survives shutdown.

Done when:

- Unchanged plugin files are not recopied.
- Nonessential work no longer delays the MCP handshake.
- Startup and cleanup behavior remains safe on supported platforms.

## Priority 2: Large-document CPU work

### PERF-06: Finish component and variant indexing

**Status:** Partially complete  
**Expected impact:** Medium for large component sets  
**Primary metric:** Local processing time for variant-heavy fixtures

Components are now indexed by component-set ID, but each variant still searches `setNode.children` with `find()`.

Implementation checklist:

- [ ] Build a child-node map once for each fetched component-set node.
- [ ] Resolve every variant node with constant-time lookup.
- [ ] Add a generated fixture with one or more very large variant sets.
- [ ] Add an assertion that output order and delta encoding are unchanged.

Measurement:

- Extend `benchmark:design-system` with variant-heavy tiers.
- Compare local processing time with simulated REST latency set low enough to expose CPU differences.

Correctness checks:

- Run design-system tool and schema compatibility tests.
- Compare response bytes and normalized response content before and after.

Done when:

- No per-variant linear child search remains.
- Variant-heavy local processing scales approximately linearly with node count.

### PERF-07: Remove Promise-per-node relationship traversal

**Status:** Open  
**Expected impact:** Medium for deeply nested or large files  
**Primary metric:** Enrichment local processing time and maximum supported depth

Relationship traversal is recursively async even though node visits perform no asynchronous I/O.

Implementation checklist:

- [ ] Replace async recursive traversal with a synchronous iterative stack.
- [ ] Preserve page name and node path information.
- [ ] Avoid allocating a complete copied path array for every node where practical.
- [ ] Ensure relationship indexes are cleared and rebuilt with existing semantics.
- [ ] Add wide and deeply nested fixtures.

Measurement:

- Add a focused enrichment benchmark or design-system scenario.
- Record wall time, CPU time, heap delta, and maximum depth completed without stack overflow.

Correctness checks:

- Compare every generated relationship index before and after.
- Run enrichment and design-code tests.

Done when:

- Traversal creates no Promise per node.
- Deep fixtures do not fail from recursive stack growth.
- Relationship output remains identical.

### PERF-08: Cache and parallelize font loading

**Status:** Open  
**Expected impact:** Medium for text-heavy components and Slides/FigJam operations  
**Primary metric:** Font-loading stage time and Plugin API call count

Fonts are deduplicated within one node operation but still loaded serially, and successful loads are not remembered across commands.

Implementation checklist:

- [ ] Add a plugin-lifetime cache keyed by family and style.
- [ ] Coalesce concurrent loads of the same font.
- [ ] Load independent unique fonts with bounded concurrency.
- [ ] Do not permanently cache failures unless a short failure TTL is justified.
- [ ] Route direct font-loading sites through the shared helper where behavior permits.
- [ ] Preserve fallback style behavior and actionable errors.

Measurement:

- Use the manual text-heavy Figma fixture.
- Measure cold font loading, repeated loading, mixed-font text, and unavailable-font fallback.
- Record unique font count, `loadFontAsync` calls, median, and p95.

Correctness checks:

- Verify text mutations still satisfy Figma's font-loading requirement.
- Test FigJam stickies, Slides text, instance properties, and text-content tools.

Done when:

- Repeated commands do not reload known successful fonts.
- Independent font loads are bounded and concurrent.
- Font fallback behavior remains unchanged.

## Priority 3: Idle overhead and cache churn

### PERF-09: Reduce stable-state discovery and UI polling

**Status:** Open  
**Expected impact:** Low to medium continuous idle savings  
**Primary metric:** Idle wakeups, health requests, and UI renders per minute

The plugin probes unconnected ports every 10 seconds while already connected and reconciles UI state every 2 seconds.

Implementation checklist:

- [ ] Instrument health probes and UI render calls per minute.
- [ ] Increase connected-state discovery to a measured 30–60 second cadence, or make it event-driven where possible.
- [ ] Preserve the current fast disconnected discovery cadence.
- [ ] Skip status DOM updates when the derived content has not changed.
- [ ] Replace the 2-second reconciliation interval with targeted events plus a slower timer only for relative-time text.
- [ ] Preserve Pause/Resume and late-starting additional server discovery.

Measurement:

- Measure ten minutes disconnected, connected to one server, and connected to multiple servers.
- Record probes, timers fired, DOM writes, CPU time if available, and reconnection latency.

Correctness checks:

- Verify late server discovery, reconnect, Pause/Resume, and cloud pairing.
- Verify status labels remain accurate.

Done when:

- Stable connected state performs materially fewer probes and DOM writes.
- Disconnected attach and reconnect latency remain within an agreed target.

### PERF-10: Make console capture connection-aware and single-pass

**Status:** Open  
**Expected impact:** Medium for log-heavy plugin commands  
**Primary metric:** CPU time, allocations, and bytes per 1,000 log events

Console interception currently JSON-round-trips object arguments and separately builds their text representation for every captured log.

Implementation checklist:

- [ ] Use one serialization pass for structured arguments and message text.
- [ ] Avoid capture work when no consumer is connected or monitoring, if the worker can be informed safely.
- [ ] Add maximum depth/size handling for very large logged objects.
- [ ] Preserve circular-reference safety.
- [ ] Decide whether bridge-internal diagnostic logs should be forwarded back through the bridge.
- [ ] Add a deterministic log-heavy benchmark.

Measurement:

- Benchmark primitive, object, array, circular, and large-object log arguments.
- Record CPU time, heap delta, encoded bytes, and dropped/truncated event counts.

Correctness checks:

- Run console monitoring and WebSocket tests.
- Verify original Figma DevTools console behavior remains intact.

Done when:

- Each argument is serialized at most once per captured event.
- No-consumer mode avoids unnecessary cloning and transfer.
- Safety limits are explicit and tested.

### PERF-11: Debounce broad design-system cache invalidation

**Status:** Open  
**Expected impact:** Medium during active editing  
**Primary metric:** Invalidations and repeat REST crawls per edit burst

Any node or style change currently invalidates variable, manifest, and complete-kit caches immediately. The broader complete-kit invalidation is required for correctness, but rapid edit bursts can cause avoidable churn.

Implementation checklist:

- [ ] Coalesce document-change invalidations per file over a short measured window.
- [ ] Preserve immediate invalidation after MCP write operations.
- [ ] Ensure a read started after the first change cannot join or return stale in-flight work.
- [ ] Keep files isolated; activity in one file must not invalidate another file's entries.
- [ ] Record invalidation generation rather than relying only on timer order.
- [ ] Add an edit-burst scenario to the deterministic cache tests.

Measurement:

- Simulate 1, 10, and 100 document-change events in a short burst followed by reads at different points.
- Record invalidation calls, REST request count, stale responses, and time until fresh data is available.

Correctness checks:

- Run design-system cache, write-tool, token, library, and multi-file tests.
- Verify disconnect invalidation remains immediate.

Done when:

- A burst produces one effective background invalidation per file.
- No stale result can be cached or returned after an invalidating change.
- Explicit writes and disconnects remain immediately visible.

## Suggested delivery slices

Implement in this order:

1. **Plugin cold-start slice:** PERF-01, PERF-02, and PERF-03.
2. **Catalog/startup slice:** PERF-04 and PERF-05.
3. **Large-document CPU slice:** PERF-06, PERF-07, and PERF-08.
4. **Idle-efficiency slice:** PERF-09, PERF-10, and PERF-11.

Keep separate benchmark results and commits for individual PERF items even when several are delivered in one vertical slice.
