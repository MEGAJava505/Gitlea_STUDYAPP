CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
