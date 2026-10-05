CREATE TABLE analyses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  length_m REAL NOT NULL,
  level TEXT NOT NULL,
  max_score REAL NOT NULL,
  terrain_source TEXT NOT NULL,
  confidence TEXT NOT NULL,
  -- How the hike actually felt, once walked: 'fine' | 'uneasy' | 'bad'.
  rating TEXT,
  -- The full analysis (sections and per-point data) as JSON.
  result TEXT NOT NULL
);
