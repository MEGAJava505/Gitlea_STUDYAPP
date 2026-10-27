CREATE TABLE IF NOT EXISTS materials (
  id TEXT PRIMARY KEY NOT NULL,
  lesson_id TEXT NOT NULL REFERENCES lessons(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  stored_path TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9A-Fa-f]*'),
  uploaded_by TEXT NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  created_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)),
  updated_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)),
  CHECK (length(trim(filename)) > 0),
  CHECK (length(trim(content_type)) > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS materials_lesson_filename_unique ON materials(lesson_id, filename);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS materials_lesson_idx ON materials(lesson_id);
