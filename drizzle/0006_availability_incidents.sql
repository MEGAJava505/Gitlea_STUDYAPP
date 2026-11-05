-- Keep at most one active outage per service while allowing unlimited recovered history.
-- This is additive and leaves existing incident rows untouched.
CREATE UNIQUE INDEX IF NOT EXISTS outage_incidents_one_open_per_service
  ON outage_incidents(service)
  WHERE ended_at IS NULL;
