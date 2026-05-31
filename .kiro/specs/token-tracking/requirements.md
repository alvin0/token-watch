# Requirements Document

## Introduction

Token Watch is a VS Code extension that tracks and analyzes token usage from two
local AI coding agents — **OpenAI Codex CLI** and **Anthropic Claude Code** — by
reading the session log files they already write to disk. It aggregates usage by
day, week, and month; breaks tokens down by type (input, output, cache, reasoning);
converts usage to USD cost; and surfaces analytics about how different models and
reasoning-effort levels (treated as distinct model variants) consume tokens. It
also analyzes tool usage, sub-agent activity, context-window fill, and session
health to explain what tokens are actually spent on.

The extension is read-only with respect to agent data. It never modifies the
source logs and never sends data over the network except to optionally refresh
public model pricing.

### Verified Data Sources (factual grounding)

These were confirmed by inspecting the local machine during requirements analysis:

**Codex** — `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`
- `session_meta` line: `payload.id`, `payload.cwd`, `payload.cli_version`,
  `payload.source` (e.g. `codex_vscode`), `payload.git.{branch,repository_url}`.
- `turn_context` line (one per turn, ~1:1 with token_count): `payload.model`
  (e.g. `gpt-5-codex`), `payload.effort` (e.g. `high`/`medium`),
  `payload.cwd`, `payload.approval_policy`, `payload.sandbox_policy.mode`,
  `payload.summary`. This is the authoritative per-turn model+effort source.
- `event_msg` with `payload.type == "token_count"`:
  - `info.total_token_usage` (cumulative for the session) and
    `info.last_token_usage` (delta for the latest turn), each containing
    `input_tokens`, `cached_input_tokens`, `output_tokens`,
    `reasoning_output_tokens`, `total_tokens`.
  - `info.model_context_window`, plus `rate_limits.{primary,secondary}` with
    `used_percent`, `window_minutes`, `resets_in_seconds`.
- `response_item` lines: `function_call` (tool name e.g. `shell`,
  `update_plan`), `function_call_output`, `custom_tool_call`,
  `reasoning`/`agent_reasoning` (reasoning summaries — content, not counted).
- An aggregate `~/.codex/sessions/cost-history.json` already exists
  (`{ date, costUsd, costJpy }[]`).

**Claude Code** — `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`
- Line types observed: `assistant`, `user`, `system`, `attachment`,
  `file-history-snapshot`.
- Assistant message lines: top-level `timestamp`, `sessionId`, `requestId`,
  `uuid`, `parentUuid`, `cwd`, `gitBranch`, `version`, `entrypoint`, `slug`,
  `isSidechain` (true for sub-agent turns), `userType`.
- `message.model` (e.g. `claude-opus-4.7`); `message.stop_reason`
  (`end_turn`/`tool_use`); `message.content` blocks include `text` and
  `tool_use` (with tool `name`, e.g. `Read`).
- `message.usage`: `input_tokens`, `output_tokens`,
  `cache_creation_input_tokens`, `cache_read_input_tokens`,
  `cache_creation.{ephemeral_1h_input_tokens, ephemeral_5m_input_tokens}`,
  and `service_tier`.
- The project directory name is the workspace path with separators replaced.

**Pricing note (external, volatile):** Public rate cards confirm pricing has a
distinct input / cached-input / output structure, and Anthropic separates cache
*write* from cache *read* rates. Exact prices change frequently, so the pricing
table must be bundled-but-editable rather than hard-coded as truth.

## Glossary

- **Source / Agent**: Codex or Claude Code.
- **Session**: one agent conversation = one `.jsonl` file.
- **Usage record**: a normalized per-turn token measurement extracted from a log.
- **Cache tokens**: `cached_input_tokens` (Codex) and
  `cache_read_input_tokens` + `cache_creation_input_tokens` (Claude).
- **Effort**: Codex reasoning-effort level (`minimal`/`low`/`medium`/`high`/`xhigh`).
- **Model Variant**: the unit of model-level analysis = base model identifier
  combined with its effort/reasoning level. For example `gpt-5.5 (high)` and
  `gpt-5.5 (xhigh)` are two distinct variants of the same base model `gpt-5.5`.
  Variants without an effort dimension (e.g. most Claude models) use the base
  model id as the variant id. Variants roll up to a base model for higher-level
  views.
- **Period**: a day, ISO week, or calendar month bucket.

---

## Requirements

### Requirement 1: Discover and parse Codex session logs

**User Story:** As a developer, I want the extension to read my Codex session
logs, so that my Codex token usage is captured without manual entry.

#### Acceptance Criteria
1. WHEN the extension activates THEN the system SHALL locate the Codex sessions
   directory at `~/.codex/sessions` (overridable via configuration).
2. WHERE the Codex sessions directory exists, the system SHALL recursively
   discover all `rollout-*.jsonl` files under the `YYYY/MM/DD` structure.
3. WHEN parsing a Codex `rollout-*.jsonl` file THEN the system SHALL extract the
   `session_meta` (id, cwd, cli_version, git branch/repo, timestamp).
4. WHEN a line has `payload.type == "token_count"` with non-null `info` THEN the
   system SHALL extract `last_token_usage` as a per-turn delta usage record with
   `input_tokens`, `cached_input_tokens`, `output_tokens`,
   `reasoning_output_tokens`, and the line `timestamp`. NOTE: in Codex logs these
   are NOT disjoint — verified on real logs, `cached_input_tokens` is a subset of
   `input_tokens`, `reasoning_output_tokens` is a subset of `output_tokens`, and
   `total_tokens == input_tokens + output_tokens`. The normalizer (Req 3.5) MUST
   decompose them into disjoint buckets before summing.
5. WHERE per-turn `last_token_usage` is null but `total_token_usage` is present,
   the system SHALL derive deltas by differencing consecutive
   `total_token_usage` values within the session to avoid double counting.
6. WHEN a usage record is created THEN the system SHALL associate it with the
   model and effort from the most recent preceding `turn_context` line in the
   same session, which carries authoritative per-turn `model` and `effort`.
7. WHEN parsing a session THEN the system SHALL capture per-turn metadata
   available in the logs — `function_call` tool names (e.g. `shell`,
   `update_plan`), `approval_policy`, `sandbox_policy.mode`, and the
   `model_context_window` — for use in tool-usage and context-fill analytics.
8. IF a log line is malformed JSON THEN the system SHALL skip that line, continue
   parsing the remainder, and record a non-fatal parse warning.

### Requirement 2: Discover and parse Claude Code session logs

**User Story:** As a developer, I want the extension to read my Claude Code
transcripts, so that my Claude token usage is captured automatically.

#### Acceptance Criteria
1. WHEN the extension activates THEN the system SHALL locate the Claude projects
   directory at `~/.claude/projects` (overridable via configuration).
2. WHERE the directory exists, the system SHALL discover all `*.jsonl` files in
   every project subdirectory.
3. WHEN parsing a Claude transcript line of type `assistant` with a
   `message.usage` object THEN the system SHALL extract a usage record with
   `input_tokens`, `output_tokens`, `cache_creation_input_tokens`,
   `cache_read_input_tokens`, `message.model`, and the line `timestamp`.
4. WHEN extracting cache tokens THEN the system SHALL treat
   `cache_read_input_tokens` and `cache_creation_input_tokens` as distinct
   sub-categories of cache usage.
5. WHERE a transcript line lacks a `message.usage` object (e.g. user or system
   lines), the system SHALL ignore that line.
6. WHEN deriving the workspace for a Claude session THEN the system SHALL prefer
   the line-level `cwd` and `gitBranch` fields, falling back to decoding the
   project directory name back to a filesystem path for grouping.
7. WHEN parsing an assistant line THEN the system SHALL capture available
   per-turn metadata — `stop_reason`, `isSidechain` (sub-agent turn),
   `tool_use` block names from `message.content`, `entrypoint`, and `version` —
   for use in tool-usage, sub-agent, and version-comparison analytics.
8. WHEN a `requestId` repeats across a contiguous group of Claude assistant lines
   (streamed cumulative updates) THEN the system SHALL count that request exactly
   once, using the FINAL (largest cumulative) `message.usage` for the group as
   the authoritative value, and SHALL replace any earlier provisional record for
   the same `requestId` rather than adding to it (last-wins / upsert by request).

### Requirement 3: Normalize usage into a unified model

**User Story:** As a developer, I want Codex and Claude usage represented the
same way, so that I can compare and aggregate them consistently.

#### Acceptance Criteria
1. WHEN any usage record is produced THEN the system SHALL normalize it to a
   common schema: `{ source, sessionId, timestamp, model, effort?, variantId,
   workspace?, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens,
   reasoningTokens }`, where `variantId` = base model + effort (e.g.
   `gpt-5.5 (high)`), falling back to the base model id when no effort exists.
2. WHERE a field is absent for a given source (e.g. `effort` for Claude,
   `reasoningTokens` for Claude, `cacheCreationTokens` for Codex), the system
   SHALL set it to 0 or undefined rather than fabricating a value.
3. WHEN computing total tokens for a record THEN the system SHALL define total =
   input + output + cacheRead + cacheCreation + reasoning, documented explicitly,
   where the five buckets are DISJOINT (non-overlapping) so nothing is counted
   twice.
4. WHEN normalizing a Codex `token_count` record THEN the system SHALL decompose
   the source fields into disjoint buckets exactly as follows, because the raw
   Codex fields overlap (verified on real logs: cached ⊆ input, reasoning ⊆
   output, total = input + output):
   - `cacheReadTokens   = cached_input_tokens`
   - `inputTokens       = input_tokens − cached_input_tokens`  (non-cached input)
   - `reasoningTokens    = reasoning_output_tokens`
   - `outputTokens      = output_tokens − reasoning_output_tokens`  (non-reasoning output)
   - `cacheCreationTokens = 0`  (Codex has no separate cache-creation field)
   The resulting normalized total (input + output + cacheRead + cacheCreation +
   reasoning) MUST equal the raw `total_tokens`. Values are clamped at 0 to guard
   against any field inconsistency.
5. WHEN normalizing a Claude `message.usage` record THEN the system SHALL map the
   fields directly because they are already disjoint buckets (Anthropic's
   `input_tokens` excludes cached tokens):
   - `inputTokens         = input_tokens`
   - `outputTokens        = output_tokens`
   - `cacheReadTokens     = cache_read_input_tokens`
   - `cacheCreationTokens = cache_creation_input_tokens`
   - `reasoningTokens     = 0`  (Claude has no separate reasoning-token field)
6. WHERE a field is absent for a given source (e.g. `effort` for Claude,
   `reasoningTokens` for Claude, `cacheCreationTokens` for Codex), the system
   SHALL set it to 0 or undefined rather than fabricating a value.
7. WHEN timestamps are read THEN the system SHALL store them as UTC and convert
   to the user's local timezone for display and bucketing.

### Requirement 4: Incremental, performant ingestion (never re-read everything)

**User Story:** As a developer with multi-gigabyte logs, I want ingestion to be
incremental and bounded, so that re-initializing the extension never re-reads all
logs and never freezes VS Code.

> **Scale context (measured on a real machine):** Codex sessions total ~3.0 GB
> across 332 files; Claude ~174 MB across 250 files. The largest single Codex
> file is ~760 MB and contains a single line of ~22 MB (embedded content). Only
> the small `token_count` and `turn_context` lines are needed. Re-reading
> everything on each activation is therefore non-viable and is explicitly
> prohibited by this requirement.

#### Acceptance Criteria

**Persistent processed store (single source of truth for the UI)**
1. WHEN usage records are extracted THEN the system SHALL persist them to a local
   structured store (e.g. SQLite via the extension's global storage, or an
   equivalent indexed file format) so that analytics read from the store, never
   from raw logs at query time.
2. WHEN the extension activates THEN the system SHALL render the dashboard
   entirely from the persisted store WITHOUT reading any raw log file, so cold
   start cost is independent of total log size.
3. WHEN the persisted store schema version differs from the current code THEN the
   system SHALL migrate or rebuild the store, and only then re-ingest.

**Reactivated old sessions (mtime-driven discovery, not date-in-path)**
> A user can reopen a months-old Codex/Claude session and continue chatting,
> which appends to an old file. Discovery MUST be driven by filesystem `mtime`,
> never by the date encoded in the file path/name or the backfill cap. Measured:
> `stat`-ing all 582 files (size+mtime, no content read) takes ~18 ms, so a full
> metadata scan every activation is cheap; only changed files are opened.

4. WHEN a file has been ingested THEN the system SHALL persist a cursor of
   `{ filePath, fileId (inode/dev or birthtime+path), size, mtime,
   lastByteOffset, headHash, tailAnchorHash, runningTotals, recentRequestIds }`,
   where `headHash` is a hash of the file's first N bytes (rotation/rewrite guard)
   and `tailAnchorHash` is a hash of the W bytes ending exactly at
   `lastByteOffset` (append guard).
5. WHEN deciding what to ingest THEN the system SHALL enumerate candidate files
   by a cheap metadata scan (size + mtime only) of the source directories and
   SHALL NOT use the date in the path/filename to decide freshness.
6. WHEN a file's stored cursor exists AND its current size and mtime both match
   the cursor THEN the system SHALL skip it entirely (no open, no read).
7. WHEN a file's mtime is newer than the stored cursor OR its size increased
   THEN the system SHALL re-evaluate it regardless of how old the file's
   path-date is, so reopened old sessions are picked up.
8. WHEN a re-evaluated file's size is at least `lastByteOffset` AND its `headHash`
   is unchanged AND the W bytes ending at `lastByteOffset` still hash to
   `tailAnchorHash` THEN the system SHALL treat it as an append and parse ONLY the
   bytes beyond `lastByteOffset`, re-verifying with a small bounded read (head
   window + the bytes around `lastByteOffset`), never the whole file.
9. IF a re-evaluated file's size shrank, OR its `headHash` changed, OR the
   tail-anchor bytes no longer match `tailAnchorHash` (rewrite/rotation/
   replacement) THEN the system SHALL discard that file's prior contribution and
   re-ingest it from the start.
10. WHEN re-ingesting a file from the start THEN the system SHALL first subtract
    that file's previously stored contribution from the aggregates to avoid
    double counting.

**Resume correctness (cumulative-counter aware)**
11. WHEN resuming an append-parse of a Codex file THEN the system SHALL restore
    the session's `runningTotals` from the cursor so that deltas derived from
    `total_token_usage` differencing remain correct across the resume boundary.
12. WHEN resuming a Claude file THEN the system SHALL retain the set of already
    counted `requestId`s near the boundary (or the last seen `requestId`) so
    streamed-update dedup (Req 2.8) survives a resume without double counting.

**Streaming parse (bounded memory, skip giant lines)**
13. WHEN reading any log file THEN the system SHALL stream it line-by-line and
    SHALL NOT load the whole file into memory.
14. WHEN a single line exceeds a configurable size cap (default 1 MB) THEN the
    system SHALL skip that line without buffering its full content, because
    needed records (`token_count`, `turn_context`, assistant `usage`) are small.
15. WHEN streaming THEN the system SHALL parse only relevant line types and cheaply
    discard others (e.g. via a fast prefix/substring check before JSON.parse).

**Off-thread, chunked, non-blocking**
16. WHEN parsing occurs THEN the system SHALL run it off the extension host's main
    path (worker thread or chunked async with yields) so the UI never blocks.
17. WHEN a large first-time backfill runs THEN the system SHALL report progress
    and SHALL allow the dashboard to be used with partial results as they land.
18. WHEN ingestion is in progress THEN the system SHALL coalesce/debounce writes
    to the store rather than writing per record.

**Incremental aggregate maintenance**
19. WHEN new usage records are ingested THEN the system SHALL update daily
    aggregates incrementally (add deltas to affected day buckets) rather than
    recomputing all-time aggregates.
20. WHEN the dashboard requests a period/week/month THEN the system SHALL derive
    it from stored daily aggregates, not by rescanning records.

**Watching & freshness**
21. WHERE file watching is enabled THEN the system SHALL watch source directories
    and ingest only changed/new files within a debounced interval (default 2s).
22. WHEN the extension activates THEN the system SHALL always perform the cheap
    full metadata scan (size/mtime, ~tens of ms) to catch reopened old sessions,
    independent of whether a watcher is active.
23. WHERE watching is unavailable or disabled THEN the system SHALL rely on the
    activation metadata scan plus a manual rescan action.

**Bounded backfill (cap applies to first read, never to updates)**
24. WHERE a historical backfill cap is configured (default 6 months) THEN the
    system SHALL, on first run, do the initial content read only for files whose
    `mtime` is within the cap, and SHALL expand on demand without re-ingesting
    already-stored files.
25. WHEN a file older than the backfill cap is later modified (mtime moves into
    the recent window because an old session was reopened) THEN the system SHALL
    ingest it regardless of the cap, because the cap bounds first-time reads, not
    ongoing updates.
26. IF total pending ingestion exceeds a configurable budget THEN the system SHALL
    prioritize most-recent files first and continue older ones in the background.

### Requirement 5: Time-based aggregation (day / week / month)

**User Story:** As a developer, I want usage rolled up by day, week, and month,
so that I can see trends over time.

#### Acceptance Criteria
1. WHEN usage records are aggregated THEN the system SHALL produce daily, ISO
   weekly, and calendar monthly buckets.
2. WHEN bucketing a record THEN the system SHALL assign it to the period
   containing its local-time timestamp.
3. WHEN a period is summarized THEN the system SHALL report token totals split by
   type (input, output, cacheRead, cacheCreation, reasoning) and total cost USD.
4. WHEN the user selects a period granularity THEN the system SHALL recompute the
   displayed series for that granularity.
5. WHERE the user selects a custom date range, the system SHALL aggregate only
   records within that inclusive range.
6. WHEN no data exists for a period THEN the system SHALL show an explicit empty
   state rather than a blank or error.

### Requirement 6: USD cost conversion

**User Story:** As a developer, I want token counts converted to USD, so that I
understand the dollar cost of my usage.

#### Acceptance Criteria
1. WHEN computing cost for a usage record THEN the system SHALL apply per-model,
   per-token-type rates (input, output, cache-read, cache-creation) from a
   pricing table.
2. WHERE a model has distinct cached-input pricing, the system SHALL apply the
   cache rate to cache tokens rather than the input rate.
3. WHEN a model in the logs has no entry in the pricing table THEN the system
   SHALL mark its cost as "unknown", exclude it from confirmed totals, and
   surface the unmapped model to the user.
4. WHERE the user edits pricing in configuration, the system SHALL use the
   user-provided rates over built-in defaults.
5. WHEN displaying cost THEN the system SHALL show USD by default and allow a
   configurable secondary currency with a user-provided exchange rate.
6. WHEN the pricing table is updated THEN the system SHALL recompute affected
   cost aggregates without requiring a re-ingestion of raw logs.

### Requirement 7: Model variant breakdown ("how each model burns tokens")

**User Story:** As a developer, I want to see how each model variant burns
tokens, where a variant is the combination of base model and effort level (so
`gpt-5.5 (high)` and `gpt-5.5 (xhigh)` are treated as two distinct variants), so
that I can understand which exact configuration is driving my cost and how
efficiently each one works.

#### Acceptance Criteria

**Variant identity**
1. WHEN aggregating usage THEN the system SHALL define a model variant as
   `baseModel + effort` and treat each distinct combination as its own row
   (e.g. `gpt-5.5 (high)` and `gpt-5.5 (xhigh)` are separate).
2. WHERE a source has no effort dimension (e.g. Claude) THEN the system SHALL use
   the base model id as the variant id and label effort as "n/a".
3. WHEN displaying variants THEN the system SHALL also support rolling them up to
   their base model and to their source for higher-level views.

**Per-variant metrics**
4. WHEN summarizing a variant for a range THEN the system SHALL show, per
   variant: tokens by type (input, output, cacheRead, cacheCreation, reasoning),
   total tokens, total cost USD, and share-of-total cost and tokens (%).
5. WHEN summarizing a variant THEN the system SHALL compute turn-level intensity
   metrics: number of turns, average tokens-per-turn, and average cost-per-turn.
6. WHEN summarizing a variant THEN the system SHALL compute an output ratio
   = output tokens / input tokens, indicating how verbose the variant is per
   unit of input.
7. WHERE reasoning tokens exist for a variant THEN the system SHALL compute a
   reasoning intensity = reasoning tokens / output tokens.
8. WHEN summarizing a variant THEN the system SHALL compute its cache efficiency
   = cacheRead tokens / (cacheRead + non-cached input tokens) (%).
9. WHEN summarizing a variant THEN the system SHALL compute a blended
   cost-per-1K-tokens (total cost / total tokens * 1000) so variants can be
   compared on a normalized price basis regardless of token mix.

**Comparison & ranking**
10. WHEN displaying the variant table THEN the system SHALL allow ranking by any
    metric (cost, tokens, cost-per-turn, cost-per-1K, cache efficiency,
    reasoning intensity).
11. WHEN two variants share a base model THEN the system SHALL support an
    effort-comparison view that shows, side by side, how cost-per-turn and
    tokens-per-turn change as effort increases (e.g. high vs xhigh).
12. WHEN rendering the variant breakdown THEN the system SHALL provide a
    proportional chart (bar or donut) of share-of-cost per variant.
13. WHEN a variant's base model has no pricing entry THEN the system SHALL still
    show its token metrics and mark cost-derived metrics as "unknown".

### Requirement 8: Sidebar dashboard UI

**User Story:** As a developer, I want a sidebar dashboard, so that I can view my
usage and analytics inside VS Code.

#### Acceptance Criteria
1. WHEN the user opens the Token Watch sidebar THEN the system SHALL render a
   dashboard inside the existing WebView (React + Zustand + Tailwind).
2. WHEN the dashboard loads THEN the system SHALL show summary cards for today,
   this week, and this month (total tokens and total USD).
3. WHEN the user switches granularity (day/week/month) THEN the system SHALL
   update a time-series chart of tokens and cost.
4. WHEN the user filters by source, model, effort, or date range THEN the system
   SHALL update all visualizations accordingly.
5. WHEN the WebView requests data THEN the extension host SHALL respond over the
   message channel with aggregated data, never raw multi-MB logs.
6. WHEN the dashboard renders THEN the system SHALL enforce the strict CSP and
   nonce already established for the WebView.
7. WHEN the underlying data changes (new ingestion) THEN the system SHALL refresh
   the dashboard without requiring the user to reopen the panel.

### Requirement 9: Status bar quick glance

**User Story:** As a developer, I want a status bar item, so that I can see
today's cost at a glance without opening the panel.

#### Acceptance Criteria
1. WHEN VS Code finishes startup THEN the system SHALL activate via
   `onStartupFinished` and show a status bar item with today's total token count
   and USD cost, read cheaply from the persisted store (no raw-log read), so the
   item appears without the user first opening the sidebar or running a command.
2. WHEN the user clicks the status bar item THEN the system SHALL open the
   sidebar dashboard.
3. WHEN today's usage updates THEN the system SHALL refresh the status bar value
   within the ingestion debounce interval.
4. WHERE the user disables the status bar item in configuration, the system SHALL
   not display it.

### Requirement 10: Configuration

**User Story:** As a developer, I want to configure paths, pricing, and behavior,
so that the extension fits my setup.

#### Acceptance Criteria
1. WHERE the user sets custom Codex/Claude data paths, the system SHALL use them
   instead of the defaults.
2. WHERE the user toggles either source on/off, the system SHALL ingest only the
   enabled sources.
3. WHERE the user overrides the pricing table or secondary currency rate, the
   system SHALL apply those values.
4. WHERE the user configures the file-watch debounce interval, the system SHALL
   honor it.
5. WHERE the user configures analytics thresholds (anomaly multiplier, default
   2x; context-fill warning, default 80%; historical backfill cap, default
   6 months) or ingestion limits (max line size, default 1 MB; watch debounce,
   default 2s), the system SHALL apply them.
6. WHEN configuration changes THEN the system SHALL apply the change without
   requiring a full VS Code restart.

#### Configuration Schema (authoritative key/type/default)

The extension SHALL contribute exactly these settings (all under the `tokenWatch`
prefix). Implementers MUST use these keys verbatim.

| Key | Type | Default | Notes / validation |
|-----|------|---------|--------------------|
| `tokenWatch.sources.codex.enabled` | boolean | `true` | toggle Codex ingestion (R10.2) |
| `tokenWatch.sources.claude.enabled` | boolean | `true` | toggle Claude ingestion (R10.2) |
| `tokenWatch.sources.codex.path` | string | `""` (→ `~/.codex/sessions`) | custom path; `""` means default (R10.1) |
| `tokenWatch.sources.claude.path` | string | `""` (→ `~/.claude/projects`) | custom path; `""` means default (R10.1) |
| `tokenWatch.pricing.overrides` | object | `{}` | map of `modelId → { inputPer1K, cachedInputPer1K, cacheCreationPer1K, outputPer1K }`; merged over bundled defaults (R10.3, R6.4) |
| `tokenWatch.currency.secondary` | string | `""` | ISO code, e.g. `"JPY"`; `""` disables (R6.5) |
| `tokenWatch.currency.secondaryRate` | number | `0` | USD→secondary multiplier; must be `> 0` to display (R6.5) |
| `tokenWatch.ingestion.watchDebounceMs` | number | `2000` | min `250`, max `60000` (R4.21, R10.4) |
| `tokenWatch.ingestion.maxLineBytes` | number | `1048576` | min `4096`; lines larger are skipped unbuffered (R4.14) |
| `tokenWatch.ingestion.backfillMonths` | number | `6` | `0` = unlimited; bounds first-time reads only (R4.24) |
| `tokenWatch.analytics.anomalyMultiplier` | number | `2` | min `1`; day cost > k×trailing median flags anomaly (R11.15) |
| `tokenWatch.analytics.contextFillWarnPct` | number | `80` | `0–100`; session peak-fill highlight threshold (R14.3) |
| `tokenWatch.statusBar.enabled` | boolean | `true` | show/hide status bar item (R9.4) |

Note: the legacy scaffold setting `tokenWatch.enabled` is superseded by the
per-source toggles above and SHALL be removed from the manifest.

### Requirement 11: Analytics & insight charts

**User Story:** As a developer, I want rich charts and insight cards about my
token usage, so that I can understand my spending patterns and efficiency at a
glance rather than just raw totals.

#### Acceptance Criteria

**Time-series & trend**
1. WHEN the dashboard renders a time series THEN the system SHALL plot tokens and
   USD cost over the selected granularity (day/week/month) as a line or bar
   chart with cost and tokens on comparable axes.
2. WHEN displaying a token time series THEN the system SHALL render tokens as a
   stacked series by type (input, output, cacheRead, cacheCreation, reasoning)
   so the composition is visible per period.
3. WHEN displaying the time series THEN the system SHALL allow breaking the
   series down by variant (one stacked segment per variant) to show how each
   variant's burn changes over time.

**Burn-rate & projection**
4. WHEN there is at least 7 days of data in the current month THEN the system
   SHALL show the current daily burn rate (USD/day) and a projected
   end-of-month cost based on the trailing trend, labeled as an estimate.

**Cache efficiency**
5. WHEN summarizing a period THEN the system SHALL compute a cache efficiency
   metric = cacheRead tokens / (cacheRead + non-cached input tokens), expressed
   as a percentage.
6. WHEN cache pricing is available THEN the system SHALL show estimated USD saved
   by caching versus the cost if those tokens had been billed at the input rate.

**Reasoning overhead (Codex)**
7. WHERE reasoning tokens exist (Codex) THEN the system SHALL show reasoning
   tokens as a share of output tokens, broken down by effort level.
8. WHEN comparing effort levels THEN the system SHALL show average cost-per-turn
   and tokens-per-turn for each effort level.

**Variant breakdown & comparison**
9. WHEN displaying the model breakdown THEN the system SHALL render a
   proportional chart (e.g. bar or donut) of share-of-cost per model variant
   (base model + effort), with a toggle to roll variants up to base model.
10. WHEN showing variant analytics THEN the system SHALL render a scatter/bubble
    chart positioning each variant by cost-per-turn (x) vs. tokens-per-turn (y)
    with bubble size = total cost, so expensive/heavy variants stand out.
11. WHEN a base model has multiple effort variants in the range THEN the system
    SHALL render an effort-scaling chart showing how cost-per-turn and
    tokens-per-turn grow across effort levels for that model.

**Comparison & breakdown**
12. WHEN both sources have data in the selected range THEN the system SHALL show
    a Codex vs. Claude Code comparison of total cost, total tokens, and cache
    efficiency side by side.
13. WHEN workspace/repo information is available THEN the system SHALL show a
    per-workspace breakdown ranking projects by cost for the selected range.

**Patterns & anomalies**
14. WHEN sufficient data exists THEN the system SHALL render a usage heatmap by
    hour-of-day and day-of-week.
15. WHEN a day's cost exceeds a configurable multiple (default 2x) of the
    trailing median THEN the system SHALL flag that day as an anomaly in the UI.
16. WHEN summarizing a range THEN the system SHALL show a leaderboard of the most
    expensive sessions with their model, source, and cost.

**General**
17. WHEN any chart has no data for the active filters THEN the system SHALL show
    an explicit empty state for that chart rather than an error or blank space.
18. WHEN the user changes filters (source/model/effort/date range) THEN the
    system SHALL update every chart and insight card consistently.

### Requirement 12: Privacy and safety

**User Story:** As a developer, I want my data to stay local, so that my code and
prompts are never leaked.

#### Acceptance Criteria
1. WHEN reading logs THEN the system SHALL extract ONLY the following allowlist of
   safe, non-content fields: token counts (input/output/cache-read/
   cache-creation/reasoning and cumulative totals), timestamps, model id, effort,
   coarse workspace/repo identifiers (cwd path, git branch/repo url), context
   window size, rate-limit percentages, and structural turn metadata — namely
   tool NAMES (not arguments), `stop_reason`, `isSidechain`, `entrypoint`,
   `version`, `approval_policy`, and `sandbox_policy.mode`. The system SHALL NEVER
   extract or store prompt text, completion/`text`/`content` blocks, reasoning
   content/summaries, or tool-call arguments/outputs.
2. WHEN persisting aggregates THEN the system SHALL store them only in the
   extension's local storage, not in any synced or remote location.
3. WHERE the extension makes any outbound request (optional pricing refresh), the
   system SHALL require explicit opt-in and SHALL send no usage data.
4. WHEN the extension cannot read a source directory due to permissions THEN the
   system SHALL warn clearly and continue with available sources.

### Requirement 13: Tool & activity analytics

**User Story:** As a developer, I want to see which agent tools consume my turns
and how my work splits between coding and reasoning, so that I understand what my
tokens are actually being spent on.

#### Acceptance Criteria
1. WHEN tool-call metadata is available THEN the system SHALL aggregate the count
   of tool calls by tool name per source (e.g. Codex `shell`/`update_plan`,
   Claude `Read`/`Edit`/etc.) for the selected range.
2. WHEN displaying tool analytics THEN the system SHALL show the most-used tools
   and their share of total tool calls.
3. WHERE Claude `isSidechain` is present THEN the system SHALL report the share
   of tokens and cost attributable to sub-agent (sidechain) turns vs. main turns.
4. WHEN `stop_reason` data is available (Claude) THEN the system SHALL show the
   distribution of turn outcomes (e.g. `end_turn` vs `tool_use`).
5. WHERE tool metadata is unavailable for a source THEN the system SHALL omit the
   affected tool charts rather than showing misleading zeros.

### Requirement 14: Context-window & session-health insights

**User Story:** As a developer, I want to see how full my context windows get and
how my sessions are shaped, so that I can spot inefficient long sessions.

#### Acceptance Criteria
1. WHERE `model_context_window` is available (Codex) THEN the system SHALL
   compute a context-fill metric = context-used tokens at a turn / context
   window, where context-used tokens is the request's full prompt context for
   that turn (Codex `last_token_usage.input_tokens`, which already includes
   `cached_input_tokens`) — NOT the cumulative session total and NOT the per-turn
   token delta — and SHALL show the peak fill per session.
2. WHEN summarizing sessions THEN the system SHALL report session-level metrics:
   number of turns, total tokens, total cost, duration (first to last timestamp),
   and average tokens-per-turn.
3. WHEN displaying session health THEN the system SHALL highlight sessions whose
   peak context fill exceeds a configurable threshold (default 80%).
4. WHERE Codex `rate_limits` data is available THEN the system MAY surface the
   most recent rate-limit `used_percent` for the primary/secondary windows as an
   informational indicator.

### Requirement 15: Data freshness & transparency

**User Story:** As a developer, I want to know how current and complete my data
is, so that I can trust the numbers.

#### Acceptance Criteria
1. WHEN the dashboard renders THEN the system SHALL display the timestamp of the
   most recent ingested usage record and the time of the last ingestion run.
2. WHERE a model in the logs has no pricing entry THEN the system SHALL show a
   visible "unmapped models" indicator listing those model ids.
3. WHEN parse warnings occurred during ingestion THEN the system SHALL expose
   counts WITHOUT blocking the dashboard, tracking two distinct categories:
   (a) malformed/unparseable lines, and (b) oversized lines skipped because they
   exceeded the max-line-size cap. Both categories count as skipped lines; the
   indicator MAY show the combined total with the breakdown available.
4. WHEN the user requests it THEN the system SHALL provide a manual "rescan"
   action that forces a full re-ingestion.

---

## Analytics Coverage Summary

All analytics are now first-class requirements (see Requirement 11). Mapping of
the original ideas to their acceptance criteria:

| Analytic | Requirement | In scope |
|----------|-------------|----------|
| Token time series (stacked by type) | 11.1, 11.2 | v1 |
| Time series broken down by variant | 11.3 | v1 |
| Burn-rate & end-of-month projection | 11.4 | v1 |
| Cache efficiency score + $ saved | 11.5, 11.6 | v1 |
| Reasoning overhead by effort (Codex) | 11.7, 11.8 | v1 |
| Share-of-cost per model variant | 11.9 | v1 |
| Variant cost/turn vs tokens/turn bubble chart | 11.10 | v1 |
| Effort-scaling chart (high vs xhigh) | 7.11, 11.11 | v1 |
| Codex vs. Claude comparison | 11.12 | v1 |
| Per-workspace / per-repo breakdown | 11.13 | v1 |
| Hour-of-day / day-of-week heatmap | 11.14 | v1 |
| Anomaly flags | 11.15 | v1 |
| Most-expensive-sessions leaderboard | 11.16 | v1 |
| Per-variant metrics table | 7.4–7.10 | v1 |
| Tool-usage breakdown (shell, Read, etc.) | 13.1, 13.2 | v1 |
| Sub-agent (sidechain) cost share | 13.3 | v1 |
| Turn-outcome distribution (stop_reason) | 13.4 | v1 |
| Context-window fill / peak per session | 14.1, 14.3 | v1 |
| Session-health metrics (duration, turns) | 14.2 | v1 |
| Rate-limit usage indicator | 14.4 | v1 (info) |
| Data-freshness & unmapped-models indicators | 15.1–15.3 | v1 |
| Budget alerts | (deferred) | later |

Note: Budget alerts (originally idea #10) are intentionally deferred from v1
unless you want them in. Data export (CSV/JSON) has been removed per your
request.

---

## Open Questions

1. **Pricing source of truth** — bundle a static default pricing table and let
   you edit it, or also support optional online refresh (opt-in)? Default
   assumption: bundle static + user-editable, no network by default. Research
   confirms prices are volatile (e.g. GPT-5 line doubled in April 2026), so
   editable is essential regardless.
2. **Codex's existing `cost-history.json`** — use it as a cross-check/fallback,
   or compute everything ourselves from raw token counts? Default assumption:
   compute ourselves; use `cost-history.json` only for reconciliation display.
3. **Effort attribution for Codex** — RESOLVED by research: each turn has a
   dedicated `turn_context` line carrying `model` + `effort`, occurring ~1:1
   with `token_count`. Requirement 1.6 now binds usage to the preceding
   `turn_context`, so variant attribution (Req 7) is reliable per turn.
4. **Historical backfill limit** — ingest all history, or cap to last N months by
   default for performance (with an option to expand)? Measured scale makes this
   important: Codex logs alone are ~3.0 GB across 332 files (largest single file
   ~760 MB). Recommended default: 6-month cap with opt-in expansion. First-time
   backfill is the only heavy operation; it runs once, off-thread, with progress,
   and never repeats (Requirement 4).
5. **Budget alerts** — include in v1 or defer? Currently deferred.
6. **Pricing granularity for cache** — Anthropic bills cache *write* (creation)
   and cache *read* at different rates, and exposes `ephemeral_1h` vs
   `ephemeral_5m` cache creation. Should v1 price these tiers separately, or
   treat all cache-creation at one rate? Default assumption: one cache-creation
   rate + one cache-read rate per model in v1; tiered ephemeral pricing later.
