import { describe, expect, it } from 'vitest';
import {
  computeChallengeFailedReputationDelta,
  computeSlashReputationDelta,
  DEFAULT_SETTLEMENT_POLICY,
} from './settlement-policy.js';
import type { Reputation } from './types.js';

const reputation = (over: Partial<Reputation> = {}): Reputation => ({
  score: 80,
  jobs: 20,
  slashes: 0,
  bondHbar: 50,
  ...over,
});

describe('computeSlashReputationDelta', () => {
  it('drops score, and bumps both slashes and jobs by one', () => {
    const delta = computeSlashReputationDelta(reputation({ score: 80, jobs: 20, slashes: 0 }));

    expect(delta).toEqual({ score: 50, jobs: 21, slashes: 1 });
  });

  it('clamps score at the configured floor instead of going negative', () => {
    const delta = computeSlashReputationDelta(reputation({ score: 10, jobs: 5, slashes: 1 }));

    expect(delta.score).toBe(0);
  });

  it('respects an injected, stricter policy', () => {
    const delta = computeSlashReputationDelta(reputation({ score: 80 }), {
      ...DEFAULT_SETTLEMENT_POLICY,
      slashScorePenalty: 5,
    });

    expect(delta.score).toBe(75);
  });
});

describe('computeChallengeFailedReputationDelta', () => {
  it('raises score and bumps jobs, leaving slashes untouched', () => {
    const delta = computeChallengeFailedReputationDelta(
      reputation({ score: 80, jobs: 20, slashes: 2 }),
    );

    expect(delta).toEqual({ score: 85, jobs: 21 });
    expect(delta.slashes).toBeUndefined();
  });

  it('clamps score at the configured ceiling instead of exceeding it', () => {
    const delta = computeChallengeFailedReputationDelta(reputation({ score: 99, jobs: 20 }));

    expect(delta.score).toBe(100);
  });

  it('the penalty for lying is heavier than the bonus for a failed challenge (asymmetric trust)', () => {
    expect(DEFAULT_SETTLEMENT_POLICY.slashScorePenalty).toBeGreaterThan(
      DEFAULT_SETTLEMENT_POLICY.challengeFailedScoreBonus,
    );
  });
});
