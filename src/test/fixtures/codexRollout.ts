/**
 * Content-scrubbed Codex `rollout-*.jsonl` fixture (Req 1.3, 1.4, 1.6, 1.7).
 *
 * Derived from the REAL Codex rollout line shapes documented in
 * `requirements.md` → "Verified Data Sources (factual grounding)". This file is
 * SCRUBBED: it contains NO prompt text, NO message/reasoning content, and NO
 * embedded file content — only structural fields and token counts. Paths, git
 * urls, and ids below are generic placeholders, not real user data.
 *
 * Lines are authored as typed objects and serialized with `JSON.stringify` so
 * the emitted JSONL is always valid. Stored as a `.ts` module (not raw
 * `.jsonl`) because the test toolchain compiles `src/**.ts` → `out/` but does
 * NOT copy non-`.ts` assets; a module guarantees the fixture is importable from
 * compiled tests without a copy step.
 */

/**
 * The decomposition example for the normalizer (task 3.2).
 *
 * For the FIRST `token_count` line below, `info.last_token_usage` is:
 *   input_tokens   = 1000  (of which cached_input_tokens     = 400)
 *   output_tokens  =  600  (of which reasoning_output_tokens = 200)
 *   total_tokens   = 1600  ( == input_tokens + output_tokens )
 *
 * Invariants (verified on real logs): cached ⊆ input, reasoning ⊆ output,
 * total == input + output.
 *
 * Disjoint normalized buckets (Req 3.4) — subtract the overlapping subsets out:
 *   cacheReadTokens     = cached_input_tokens                    = 400
 *   inputTokens         = input_tokens  − cached_input_tokens    = 600
 *   reasoningTokens     = reasoning_output_tokens                = 200
 *   outputTokens        = output_tokens − reasoning_output_tokens = 400
 *   cacheCreationTokens = 0   (Codex has no separate cache-creation field)
 * Sum of disjoint buckets = 400 + 600 + 200 + 400 + 0 = 1600 == rawTotalTokens.
 */
export const CODEX_DECOMP_EXAMPLE = {
  rawTotalTokens: 1600,
  raw: {
    input_tokens: 1000,
    cached_input_tokens: 400,
    output_tokens: 600,
    reasoning_output_tokens: 200,
    total_tokens: 1600,
  },
  expected: {
    cacheReadTokens: 400,
    inputTokens: 600,
    reasoningTokens: 200,
    outputTokens: 400,
    cacheCreationTokens: 0,
  },
} as const;

/** Generic, scrubbed session identity used across the fixture lines. */
export const CODEX_SESSION_ID = "00000000-0000-4000-8000-000000000001";
export const CODEX_MODEL = "gpt-5-codex";
export const CODEX_CONTEXT_WINDOW = 272000;

/**
 * The ordered Codex rollout lines as plain objects (pre-serialization). Covers:
 * session_meta, turn_context (model + effort), response_item function_calls
 * (tool names only), and event_msg `token_count` lines carrying
 * total/last token usage, model_context_window, and rate_limits.
 */
const CODEX_LINE_OBJECTS: ReadonlyArray<Record<string, unknown>> = [
  // session_meta — session identity / origin (Req 1.3). No content.
  {
    timestamp: "2025-01-15T10:00:00.000Z",
    type: "session_meta",
    payload: {
      id: CODEX_SESSION_ID,
      timestamp: "2025-01-15T10:00:00.000Z",
      cwd: "/home/dev/projects/example",
      source: "codex_vscode",
      cli_version: "0.45.0",
      git: {
        branch: "main",
        repository_url: "https://github.com/example/example.git",
      },
    },
  },

  // turn_context — authoritative per-turn model + effort for the next turn (Req 1.6).
  {
    timestamp: "2025-01-15T10:00:01.000Z",
    type: "turn_context",
    payload: {
      model: CODEX_MODEL,
      effort: "high",
      cwd: "/home/dev/projects/example",
      approval_policy: "on-request",
      sandbox_policy: { mode: "workspace-write" },
      summary: "auto",
    },
  },

  // response_item function_call lines — tool names only, arguments scrubbed (Req 1.7, 13.1).
  {
    timestamp: "2025-01-15T10:00:02.000Z",
    type: "response_item",
    payload: { type: "function_call", name: "shell", arguments: "", call_id: "call_0001" },
  },
  {
    timestamp: "2025-01-15T10:00:03.000Z",
    type: "response_item",
    payload: { type: "function_call", name: "update_plan", arguments: "", call_id: "call_0002" },
  },

  // event_msg token_count #1 — THE DECOMPOSITION EXAMPLE (Req 1.4, 3.4).
  // last_token_usage is the per-turn delta; total_token_usage is the cumulative
  // session total (equal to last here because this is the first counted turn).
  {
    timestamp: "2025-01-15T10:00:04.000Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: 1000,
          cached_input_tokens: 400,
          output_tokens: 600,
          reasoning_output_tokens: 200,
          total_tokens: 1600,
        },
        last_token_usage: {
          input_tokens: 1000,
          cached_input_tokens: 400,
          output_tokens: 600,
          reasoning_output_tokens: 200,
          total_tokens: 1600,
        },
        model_context_window: CODEX_CONTEXT_WINDOW,
      },
      rate_limits: {
        primary: { used_percent: 12.5, window_minutes: 300, resets_in_seconds: 3600 },
        secondary: { used_percent: 45, window_minutes: 10080, resets_in_seconds: 86400 },
      },
    },
  },

  // turn_context — a second turn at a different effort (distinct variant, Req 7.1).
  {
    timestamp: "2025-01-15T10:01:00.000Z",
    type: "turn_context",
    payload: {
      model: CODEX_MODEL,
      effort: "medium",
      cwd: "/home/dev/projects/example",
      approval_policy: "on-request",
      sandbox_policy: { mode: "workspace-write" },
      summary: "auto",
    },
  },

  // response_item function_call for the second turn.
  {
    timestamp: "2025-01-15T10:01:01.000Z",
    type: "response_item",
    payload: { type: "function_call", name: "shell", arguments: "", call_id: "call_0003" },
  },

  // event_msg token_count #2 — cumulative total_token_usage grows; last_token_usage
  // is the delta for this turn. (cached ⊆ input, reasoning ⊆ output, total == in+out.)
  {
    timestamp: "2025-01-15T10:01:02.000Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: 1500,
          cached_input_tokens: 600,
          output_tokens: 900,
          reasoning_output_tokens: 300,
          total_tokens: 2400,
        },
        last_token_usage: {
          input_tokens: 500,
          cached_input_tokens: 200,
          output_tokens: 300,
          reasoning_output_tokens: 100,
          total_tokens: 800,
        },
        model_context_window: CODEX_CONTEXT_WINDOW,
      },
      rate_limits: {
        primary: { used_percent: 18.25, window_minutes: 300, resets_in_seconds: 3000 },
        secondary: { used_percent: 46, window_minutes: 10080, resets_in_seconds: 85800 },
      },
    },
  },
];

/** The fixture lines as parsed objects (convenient for direct assertions). */
export const CODEX_ROLLOUT_OBJECTS: ReadonlyArray<Record<string, unknown>> =
  CODEX_LINE_OBJECTS;

/** The fixture as an array of individual JSONL line strings. */
export const CODEX_ROLLOUT_LINES: string[] = CODEX_LINE_OBJECTS.map((o) =>
  JSON.stringify(o),
);

/** The fixture as a single multi-line JSONL string (newline-separated). */
export const CODEX_ROLLOUT_JSONL: string = CODEX_ROLLOUT_LINES.join("\n");
