import { describe, expect, it } from 'vitest';
import {
  activateCompensation,
  compensationIsActive,
  COMPENSATION_ACTIVATION_MS,
  COMPENSATION_WINDOW_MS,
  outageCrossesDeadline,
} from '../../src/domain/reliability/compensation';
import type { UserId } from '../../src/shared/contracts';

const user = 'student-1' as UserId;
const outage = { id: 'incident-1', service: 'gitea', startedAt: 1_000, recoveredAt: 3_000, confirmed: true };

describe('automatic outage compensation', () => {
  it('requires confirmed recovery after the deadline', () => {
    expect(outageCrossesDeadline(outage, 2_000)).toBe(true);
    expect(outageCrossesDeadline({ ...outage, confirmed: false }, 2_000)).toBe(false);
    expect(outageCrossesDeadline({ ...outage, recoveredAt: 2_000 }, 2_000)).toBe(false);
  });

  it('grants exactly one ten-minute window and keeps replay idempotent', () => {
    const first = activateCompensation({ outage, userId: user, deadline: 2_000, now: outage.recoveredAt! + 100 });
    expect(first.activationExpiresAt).toBe(outage.recoveredAt! + COMPENSATION_ACTIVATION_MS);
    expect(first.endsAt - first.startsAt).toBe(COMPENSATION_WINDOW_MS);
    expect(compensationIsActive(first, first.endsAt - 1)).toBe(true);
    expect(compensationIsActive(first, first.endsAt)).toBe(false);
    expect(activateCompensation({ outage, userId: user, deadline: 2_000, now: first.endsAt - 1, existing: first })).toBe(first);
  });

  it('allows activation through the 24-hour boundary, then expires', () => {
    const atBoundary = activateCompensation({
      outage, userId: user, deadline: 2_000,
      now: outage.recoveredAt! + COMPENSATION_ACTIVATION_MS,
    });
    expect(atBoundary.startsAt).toBe(outage.recoveredAt! + COMPENSATION_ACTIVATION_MS);
    expect(() => activateCompensation({
      outage, userId: user, deadline: 2_000,
      now: outage.recoveredAt! + COMPENSATION_ACTIVATION_MS + 1,
    })).toThrow(/deadline/i);
  });

  it('does not start a window while recovery is unconfirmed', () => {
    expect(() => activateCompensation({
      outage: { ...outage, recoveredAt: null }, userId: user, deadline: 2_000, now: 3_001,
    })).toThrow(/compensation/i);
  });

  it('does not replay an existing window for another user or outage', () => {
    const existing = activateCompensation({ outage, userId: user, deadline: 2_000, now: 3_100 });
    expect(() => activateCompensation({
      outage, userId: 'student-2' as UserId, deadline: 2_000, now: 3_200, existing,
    })).toThrow(/window/i);
    expect(() => activateCompensation({
      outage: { ...outage, id: 'incident-2' }, userId: user, deadline: 2_000, now: 3_200, existing,
    })).toThrow(/window/i);
  });
});
