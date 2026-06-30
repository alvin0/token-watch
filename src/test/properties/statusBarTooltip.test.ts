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

  test('includes codex usage section when rate limit is present', () => {
    const tooltip = buildStatusBarTooltip(summary, {
      primaryPct: 17,
      secondaryPct: 3,
      remainingSeconds: 14014,
      weeklyResetAtUtc: 1783393903000,
    });

    assert.ok(tooltip.includes('Codex usage'));
    assert.ok(tooltip.includes('5h limit: 83% remaining | resets in 3h 53m'));
    assert.ok(tooltip.includes('Weekly: 97% remaining | resets '));
  });

  test('omits codex usage section when rate limit is missing', () => {
    const tooltip = buildStatusBarTooltip(summary);

    assert.ok(!tooltip.includes('Codex usage'));
  });

  test('shows unavailable message when codex usage cannot be fetched', () => {
    const tooltip = buildStatusBarTooltip(summary, undefined, 'Codex usage not avilable');

    assert.ok(tooltip.includes('Codex usage not avilable'));
    assert.ok(!tooltip.includes('5h limit:'));
    assert.ok(!tooltip.includes('Weekly:'));
  });
});