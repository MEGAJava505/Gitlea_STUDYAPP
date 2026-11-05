import type { ConfirmedOutage } from './compensation';

export interface AvailabilityIncident extends ConfirmedOutage {
  details: string;
}

/**
 * Small persistence-independent monitor state machine. A scheduler supplies
 * probes from a separate process/host; callers persist the returned incidents.
 */
export class AvailabilityMonitor {
  private readonly open = new Map<string, AvailabilityIncident>();
  private sequence = 0;

  constructor(private readonly now: () => number = Date.now) {}

  recordProbe(input: { service: string; available: boolean; checkedAt?: number; details?: string }): AvailabilityIncident | null {
    const at = input.checkedAt ?? this.now();
    const current = this.open.get(input.service);
    if (input.available) {
      if (!current) return null;
      if (current.recoveredAt === null) current.recoveredAt = at;
      current.confirmed = true;
      return { ...current };
    }
    if (current) return { ...current };
    const incident: AvailabilityIncident = {
      id: `${input.service}-${at}-${++this.sequence}`,
      service: input.service,
      startedAt: at,
      recoveredAt: null,
      confirmed: false,
      details: input.details ?? '',
    };
    this.open.set(input.service, incident);
    return { ...incident };
  }

  forgetRecovered(service: string): void {
    const incident = this.open.get(service);
    if (incident?.recoveredAt !== null) this.open.delete(service);
  }

  current(service: string): AvailabilityIncident | null {
    const incident = this.open.get(service);
    return incident ? { ...incident } : null;
  }
}
