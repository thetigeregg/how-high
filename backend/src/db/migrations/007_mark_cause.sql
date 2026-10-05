-- What made a stretch uneasy or bad, when the user has said:
-- 'drops' (the ground falling away beside the path), 'view' (how much height
-- the view shows), 'both', or 'other' (something the app does not measure,
-- such as a narrow path). Null when not said, and always for 'fine'.
ALTER TABLE marks ADD COLUMN cause TEXT;
