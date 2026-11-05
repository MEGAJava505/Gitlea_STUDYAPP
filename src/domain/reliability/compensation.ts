import { errors, type UserId } from '../../shared/contracts';

export const COMPENSATION_ACTIVATION_MS = 24 * 60 * 60 * 1000;
export const COMPENSATION_WINDOW_MS = 10 * 60 * 1000;

export interface ConfirmedOutage {
  id: string;
  service: string;
  startedAt: number;
  recoveredAt: number | null;
  confirmed: boolean;
}

export interface CompensationWindow {
  outageId: string;
  userId: UserId;
  activatedAt: number;
  activationExpiresAt: number;
  startsAt: number;
  endsAt: number;
}

/** An outage can compensate only deadlines that it actually crossed. */
export function outageCrossesDeadline(outage: ConfirmedOutage, deadline: number): boolean {
  return outage.confirmed
    && outage.recoveredAt !== null
    && outage.startedAt <= deadline
    && outage.recoveredAt > deadline;
}

export function activationExpiresAt(outage: ConfirmedOutage): number {
  if (!outage.confirmed || outage.recoveredAt === null) {
    throw errors.invalidState('Compensation is unavailable before confirmed recovery');
  }
  return outage.recoveredAt + COMPENSATION_ACTIVATION_MS;
}

/**
 * First authorized access starts one personal ten-minute window. Replays return
 * the original window, so login/page refreshes cannot extend or reset it.
 */
export function activateCompensation(input: {
  outage: ConfirmedOutage;
  userId: UserId;
  now: number;
  deadline: number;
  existing?: CompensationWindow | null;
}): CompensationWindow {
  if (input.existing) {
    if (input.existing.outageId !== input.outage.id || input.existing.userId !== input.userId) {
      throw errors.invalidState('Existing compensation window belongs to another outage or user');
    }
    return input.existing;
  }
  if (!outageCrossesDeadline(input.outage, input.deadline)) {
    throw errors.invalidState('This outage does not qualify for deadline compensation');
  }
  const expires = activationExpiresAt(input.outage);
  if (input.outage.recoveredAt !== null && input.now < input.outage.recoveredAt) {
    throw errors.invalidState('Compensation is unavailable before confirmed recovery');
  }
  if (input.now > expires) throw errors.deadlineExpired();
  return {
    outageId: input.outage.id,
    userId: input.userId,
    activatedAt: input.now,
    activationExpiresAt: expires,
    startsAt: input.now,
    endsAt: input.now + COMPENSATION_WINDOW_MS,
  };
}

export function compensationIsActive(window: CompensationWindow, now: number): boolean {
  return now >= window.startsAt && now < window.endsAt;
}
