-- Add in place: rebuilding/dropping submissions would lose immutable triggers
-- and break reviews/test_runs foreign keys on a populated database.
-- The temporary default permits SQLite ADD COLUMN on existing rows; the
-- insert guard below requires all future writers to supply an explicit key.
ALTER TABLE submissions ADD COLUMN idempotency_key TEXT NOT NULL
  DEFAULT '__legacy_backfill__' CHECK (length(trim(idempotency_key)) > 0);
--> statement-breakpoint
UPDATE submissions SET idempotency_key = 'legacy:' || id;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS submissions_repository_key_unique
  ON submissions(repository_link_id, idempotency_key);
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS submissions_key_required
BEFORE INSERT ON submissions
WHEN NEW.idempotency_key = '__legacy_backfill__'
BEGIN SELECT RAISE(ABORT, 'submission idempotency key is required'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS submissions_key_immutable
BEFORE UPDATE OF idempotency_key ON submissions
WHEN OLD.idempotency_key IS NOT NEW.idempotency_key
BEGIN SELECT RAISE(ABORT, 'submission idempotency key is immutable'); END;
