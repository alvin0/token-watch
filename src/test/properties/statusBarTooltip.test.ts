import * as assert from 'node:assert';
import { buildStatusBarTooltip, type StatusBarUsageSummary } from '../../host/StatusBarController.js';

suite('Status bar tooltip', () => {
  const summary: StatusBarUsageSummary = {
    tokens: 12345,
    cost: 1.23,
    inputTokens: 1000,
    outputTokens: 2000,
    reasoningTokens: 300,
    cacheReadTokens: 400,
    cacheCreationTokens: 500,
    turns: 7,
  };

  test('uses the compact current-usage summary layout', () => {
    const tooltip = buildStatusBarTooltip(summary);

    assert.ok(tooltip.startsWith('Token Watch · Current usage\n\n'));
    assert.ok(tooltip.includes('12.3K tokens · $1.23 · 7 turns'));
    assert.ok(tooltip.includes('Input 1.0K · Output 2.0K · Reasoning 300'));
    assert.ok(tooltip.includes('Cache 400 read · 500 write'));
    assert.ok(!tooltip.includes('Input:'));
    assert.ok(!tooltip.includes('Total:'));
  });

  test('includes codex usage section when rate limit is present', () => {
    const tooltip = buildStatusBarTooltip(summary, {
      primaryPct: 17,
      secondaryPct: 3,
      remainingSeconds: 14014,
      weeklyResetAtUtc: 1783393903000,
      windows: [
        { id: 'codex:primary', label: '5h limit', usedPct: 17, resetAtUtc: 1_783_735_800_000 },
        { id: 'codex:secondary', label: 'Weekly', usedPct: 3, resetAtUtc: 1_783_393_903_000 },
        { id: 'spark:primary', label: 'GPT-5.3-Codex-Spark · 5h limit', usedPct: 5 },
      ],
    });

    assert.ok(tooltip.includes('\nCODEX\n'));
    assert.ok(tooltip.includes('5h 83% left · resets '));
    assert.ok(tooltip.includes('Week 97% left · resets '));
    assert.ok(tooltip.includes('Spark · 5h 95%'));
    assert.ok(!tooltip.includes('GPT-5.3-Codex-Spark'));
    assert.ok(!tooltip.includes('remaining'));
  });

  test('omits codex usage section when rate limit is missing', () => {
    const tooltip = buildStatusBarTooltip(summary);

    assert.ok(!tooltip.includes('\nCODEX\n'));
  });

  test('shows unavailable message when codex usage cannot be fetched', () => {
    const tooltip = buildStatusBarTooltip(summary, undefined, 'Codex usage not available');

    assert.ok(tooltip.includes('CODEX\nUsage not available'));
    assert.ok(!tooltip.includes('5h 83%'));
    assert.ok(!tooltip.includes('Week 97%'));
  });

  test('includes Claude Code five-hour and weekly quota', () => {
    const tooltip = buildStatusBarTooltip(summary, undefined, undefined, {
      fiveHourPct: 12,
      weeklyPct: 34,
      fiveHourResetAtUtc: 1_783_735_800_000,
      weeklyResetAtUtc: 1_783_832_400_000,
      windows: [
        { id: 'session', label: '5h limit', usedPct: 12, resetAtUtc: 1_783_735_800_000 },
        { id: 'weekly', label: 'Weekly', usedPct: 34, resetAtUtc: 1_783_832_400_000 },
        { id: 'weekly:model:fable', label: 'Fable · Weekly', usedPct: 56 },
      ],
    });

    assert.ok(tooltip.includes('\nCLAUDE CODE\n'));
    assert.ok(tooltip.includes('5h 88% left · resets '));
    assert.ok(tooltip.includes('Week 66% left · resets '));
    assert.ok(tooltip.includes('Fable · Week 44%'));
    assert.ok(!tooltip.includes('remaining'));
  });

  test('omits quota rows and fields that have no value', () => {
    const tooltip = buildStatusBarTooltip(summary, {
      windows: [
        { id: 'empty', label: 'Unavailable model' },
        { id: 'percent-only', label: 'Percent only', usedPct: 25 },
        { id: 'reset-only', label: 'Reset only', resetAtUtc: 1_783_735_800_000 },
      ],
    });

    assert.ok(!tooltip.includes('Unavailable model'));
    assert.ok(tooltip.includes('Percent only · Limit 75%'));
    assert.ok(tooltip.includes('Reset only · Limit · resets '));
    assert.ok(!tooltip.includes('n/a'));
    assert.ok(!tooltip.includes('remaining'));
  });

  test('omits provider section when all quota rows are empty', () => {
    const tooltip = buildStatusBarTooltip(summary, {
      windows: [{ id: 'spark', label: 'GPT-5.3-Codex-Spark' }],
    });

    assert.ok(!tooltip.includes('\nCODEX\n'));
    assert.ok(!tooltip.includes('GPT-5.3-Codex-Spark'));
  });

  test('shows unavailable message when Claude Code usage cannot be fetched', () => {
    const tooltip = buildStatusBarTooltip(
      summary,
      undefined,
      undefined,
      undefined,
      'Claude Code usage not available',
    );

    assert.ok(tooltip.includes('CLAUDE CODE\nUsage not available'));
  });
});
