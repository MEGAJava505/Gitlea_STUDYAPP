import { randomUUID } from 'node:crypto';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { outageIncidents } from '../db/schema';
import * as relations from '../db/relations';

export interface AvailabilityProbe {
  service: string;
  available: boolean;
  checkedAt?: number;
  details?: string;
}

export interface AvailabilityIncidentRecord {
  id: string;
  service: string;
  startedAt: number;
  recoveredAt: number | null;
  confirmed: boolean;
  details: string;
}

type Db = BetterSQLite3Database<typeof relations>;

/** SQLite-backed durable state for independently scheduled availability probes. */
export class DbAvailabilityIncidentRepository {
  constructor(private readonly db: Db, private readonly now: () => number = Date.now) {}

  recordProbe(input: AvailabilityProbe): AvailabilityIncidentRecord | null {
    const at = input.checkedAt ?? this.now();
    const current = this.openIncident(input.service);

    if (input.available) {
      if (!current) return null;
      this.db.update(outageIncidents)
        .set({ endedAt: at, confirmed: true })
        .where(eq(outageIncidents.id, current.id))
        .run();
      return this.getIncident(current.id);
    }

    if (current) return current;

    const id = randomUUID();
    try {
      this.db.insert(outageIncidents).values({
        id,
        service: input.service,
        startedAt: at,
        details: input.details ?? '',
      }).run();
    } catch (error) {
      // A second scheduler may have opened the same service concurrently. The
      // partial unique index makes one row win; return that durable winner.
      const winner = this.openIncident(input.service);
      if (winner) return winner;
      throw error;
    }
    return this.getIncident(id);
  }

  listOpen(service: string): AvailabilityIncidentRecord[] {
    return this.db.select().from(outageIncidents)
      .where(and(eq(outageIncidents.service, service), isNull(outageIncidents.endedAt)))
      .orderBy(asc(outageIncidents.startedAt), asc(outageIncidents.id))
      .all()
      .map(toIncident);
  }

  private openIncident(service: string): AvailabilityIncidentRecord | null {
    const row = this.db.select().from(outageIncidents)
      .where(and(eq(outageIncidents.service, service), isNull(outageIncidents.endedAt)))
      .orderBy(asc(outageIncidents.startedAt), asc(outageIncidents.id))
      .get();
    return row ? toIncident(row) : null;
  }

  private getIncident(id: string): AvailabilityIncidentRecord {
    const row = this.db.select().from(outageIncidents).where(eq(outageIncidents.id, id)).get();
    if (!row) throw new Error(`Availability incident ${id} was not persisted`);
    return toIncident(row);
  }
}

function toIncident(row: typeof outageIncidents.$inferSelect): AvailabilityIncidentRecord {
  return {
    id: row.id,
    service: row.service,
    startedAt: row.startedAt,
    recoveredAt: row.endedAt,
    confirmed: row.confirmed,
    details: row.details,
  };
}
