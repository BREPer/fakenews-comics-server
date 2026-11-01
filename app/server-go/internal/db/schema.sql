PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS libraries (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL CHECK (type IN ('chapter','single')),
  paths       TEXT NOT NULL,
  sort        INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS comics (
  id               TEXT PRIMARY KEY,
  library_id       TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  title            TEXT NOT NULL,
  raw_title        TEXT NOT NULL,
  author           TEXT,
  description      TEXT,
  format           TEXT NOT NULL,
  path             TEXT NOT NULL UNIQUE,
  cover_path       TEXT,
  size_bytes       INTEGER NOT NULL DEFAULT 0,
  chapter_count    INTEGER NOT NULL DEFAULT 0,
  page_count       INTEGER NOT NULL DEFAULT 0,
  tags             TEXT NOT NULL DEFAULT '[]',
  file_modified_at INTEGER NOT NULL,
  added_at         INTEGER NOT NULL,
  meta_locked      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_comics_library ON comics(library_id);
CREATE INDEX IF NOT EXISTS idx_comics_added    ON comics(added_at DESC);
-- 列表默认排序是 `ORDER BY c.added_at DESC, c.id`（次键保证分页稳定）。
-- 只索引 added_at 时，次键会让 SQLite 退化到 TEMP B-TREE 再排序；把 id 一起放进
-- 索引就能整段走索引。库内过滤时同理需要 (library_id, added_at, id)。
CREATE INDEX IF NOT EXISTS idx_comics_added_id  ON comics(added_at DESC, id);
CREATE INDEX IF NOT EXISTS idx_comics_lib_added ON comics(library_id, added_at DESC, id);

CREATE TABLE IF NOT EXISTS reading_progress (
  comic_id      TEXT PRIMARY KEY,
  chapter_id    TEXT NOT NULL,
  chapter_index INTEGER NOT NULL,
  page_index    INTEGER NOT NULL,
  page_count    INTEGER NOT NULL,
  percent       REAL    NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_progress_updated ON reading_progress(updated_at DESC);

-- 分章进度（chapter_progress）已整体移除：进度只记录「当前正在阅读的章节」
-- （reading_progress 一行一漫画）。老库里遗留的表在这里清掉，避免旧数据被当成有效数据。
DROP TABLE IF EXISTS chapter_progress;

CREATE TABLE IF NOT EXISTS favorites (
  comic_id   TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 登录会话（单账号门禁）。只存 token 的 SHA-256 散列：DB 被拷走也无法直接冒用会话。
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  username   TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
