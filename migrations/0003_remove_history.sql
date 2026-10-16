-- Keep only current attendance; reset deletes it instead of archiving it.
DELETE FROM checkins WHERE round_id<>(SELECT current_round FROM settings WHERE id=1);
DELETE FROM rounds WHERE id<>(SELECT current_round FROM settings WHERE id=1);
