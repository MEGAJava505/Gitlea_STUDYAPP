import type { DbAvailabilityIncidentRepository, AvailabilityIncidentRecord } from './db-availability-incident-repository';

export interface AvailabilityProbeResult {
  available: boolean;
  details?: string;
}

export type AvailabilityProbe = () => AvailabilityProbeResult | Promise<AvailabilityProbeResult>;

export class AvailabilityProbeRunner {
  constructor(
    private readonly repository: DbAvailabilityIncidentRepository,
    private readonly service: string,
    private readonly probe: AvailabilityProbe,
    private readonly now: () => number = Date.now,
  ) {}

  async runOnce(): Promise<AvailabilityIncidentRecord | null> {
    let result: AvailabilityProbeResult;
    try {
      result = await this.probe();
    } catch {
      result = { available: false, details: 'Availability probe failed' };
    }
    return this.repository.recordProbe({
      service: this.service,
      available: result.available,
      checkedAt: this.now(),
      details: result.details,
    });
  }
}
