/** Credential-free monitor diagnostics shared with settings. Counters reset on plugin reload. */
export const REVIEW_DECISIONS = ['continued', 'completed', 'waiting-user', 'waiting-work', 'blocked', 'limited', 'skipped', 'unverified'] as const;
export type ReviewDecision = typeof REVIEW_DECISIONS[number];
export const REVIEW_REASONS = ['missing-outcome', 'pending-action', 'reported-complete', 'needs-user', 'work-running', 'reported-blocked', 'continuation-limit', 'no-progress', 'goal-owned', 'service-unavailable', 'cancelled', 'truncated', 'request-failed', 'disabled', 'superseded', 'invalid-evidence', 'tool-concluded'] as const;
export type ReviewReason = typeof REVIEW_REASONS[number];

export interface TurnMonitorStatus {
  available: boolean;
  checks: number;
  continuations: number;
  requestRetries: number;
  last?: { at: string; decision: ReviewDecision; reason: ReviewReason };
}
