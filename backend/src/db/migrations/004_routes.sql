-- Routes fetched from a Google Maps link sit alongside uploaded hikes.
-- kind: 'hike' (from a GPX file) | 'route' (from a link).
ALTER TABLE analyses ADD COLUMN kind TEXT NOT NULL DEFAULT 'hike';
ALTER TABLE analyses ADD COLUMN source_url TEXT;
