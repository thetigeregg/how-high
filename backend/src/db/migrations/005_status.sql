-- Whether a hike or route has actually been done, or is only being considered.
-- Anything already rated or marked has evidently been done.
ALTER TABLE analyses ADD COLUMN status TEXT NOT NULL DEFAULT 'planned';
UPDATE analyses SET status = 'done' WHERE rating IS NOT NULL OR id IN (SELECT analysis_id FROM marks);
