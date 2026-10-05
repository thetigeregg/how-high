-- One row holding every tweakable knob as JSON; missing knobs fall back to
-- their defaults when read.
CREATE TABLE settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  data TEXT NOT NULL
);
INSERT INTO settings (id, data) VALUES (1, '{}');
