-- How a specific stretch (or point, when start_m = end_m) of a hike felt in
-- reality. 'turned_back' marks where the hike was abandoned: everything after
-- it was never walked.
CREATE TABLE marks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  analysis_id INTEGER NOT NULL REFERENCES analyses(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  start_m REAL NOT NULL,
  end_m REAL NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX marks_analysis ON marks(analysis_id);
