-- The settings as they were before a suggestion was applied, so that it can
-- be undone. Null when there is nothing to go back to.
ALTER TABLE settings ADD COLUMN previous TEXT;
