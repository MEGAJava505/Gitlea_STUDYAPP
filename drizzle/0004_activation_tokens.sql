CREATE TABLE activation_tokens (
 token_hmac TEXT PRIMARY KEY NOT NULL CHECK(length(token_hmac)=64),
 kind TEXT NOT NULL CHECK(kind IN ('qr','email')),
 group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE RESTRICT,
 email TEXT,
 qr_token_hmac TEXT REFERENCES activation_tokens(token_hmac) ON DELETE RESTRICT,
 expires_at INTEGER NOT NULL,
 used_at INTEGER,
 revoked_at INTEGER,
 CHECK((kind='qr' AND email IS NULL AND qr_token_hmac IS NULL AND used_at IS NULL)
 OR (kind='email' AND email IS NOT NULL AND qr_token_hmac IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX activation_tokens_expiry_idx ON activation_tokens(expires_at);
--> statement-breakpoint
CREATE TABLE activation_rate_limits (
 key_hash TEXT PRIMARY KEY NOT NULL,
 window_start INTEGER NOT NULL,
 attempts INTEGER NOT NULL CHECK(attempts > 0)
);
