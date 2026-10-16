CREATE TABLE rounds (id INTEGER PRIMARY KEY AUTOINCREMENT, started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), ended_at TEXT);
INSERT INTO rounds DEFAULT VALUES;
CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK(id=1), current_round INTEGER NOT NULL REFERENCES rounds(id));
INSERT INTO settings SELECT 1,id FROM rounds;
CREATE TABLE seats (room TEXT NOT NULL CHECK(room IN ('A','B')), seat INTEGER NOT NULL CHECK(seat BETWEEN 1 AND 48), blocked INTEGER NOT NULL DEFAULT 0 CHECK(blocked IN (0,1)), PRIMARY KEY(room,seat));
WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<48) INSERT INTO seats(room,seat) SELECT 'A',x FROM n UNION ALL SELECT 'B',x FROM n;
CREATE TABLE checkins (
 id INTEGER PRIMARY KEY AUTOINCREMENT, round_id INTEGER NOT NULL REFERENCES rounds(id),
 user_id TEXT NOT NULL, email TEXT NOT NULL, class_name TEXT NOT NULL CHECK(length(class_name) BETWEEN 1 AND 20),
 student_number INTEGER NOT NULL CHECK(student_number BETWEEN 1 AND 99),
 room TEXT NOT NULL, seat INTEGER NOT NULL, checked_in_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 FOREIGN KEY(room,seat) REFERENCES seats(room,seat),
 UNIQUE(round_id,user_id), UNIQUE(round_id,room,seat), UNIQUE(round_id,class_name,student_number)
);
CREATE TRIGGER checkin_guard BEFORE INSERT ON checkins BEGIN
 SELECT RAISE(ABORT,'ROUND_CHANGED') WHERE NEW.round_id<>(SELECT current_round FROM settings WHERE id=1);
 SELECT RAISE(ABORT,'SEAT_BLOCKED') WHERE NOT EXISTS(SELECT 1 FROM seats WHERE room=NEW.room AND seat=NEW.seat AND blocked=0);
 SELECT RAISE(ABORT,'ALREADY_CHECKED_IN') WHERE EXISTS(SELECT 1 FROM checkins WHERE round_id=NEW.round_id AND user_id=NEW.user_id);
 SELECT RAISE(ABORT,'SEAT_TAKEN') WHERE EXISTS(SELECT 1 FROM checkins WHERE round_id=NEW.round_id AND room=NEW.room AND seat=NEW.seat);
 SELECT RAISE(ABORT,'STUDENT_TAKEN') WHERE EXISTS(SELECT 1 FROM checkins WHERE round_id=NEW.round_id AND class_name=NEW.class_name AND student_number=NEW.student_number);
END;
CREATE TRIGGER block_guard BEFORE UPDATE OF blocked ON seats WHEN NEW.blocked=1 BEGIN
 SELECT RAISE(ABORT,'SEAT_TAKEN') WHERE EXISTS(SELECT 1 FROM checkins WHERE round_id=(SELECT current_round FROM settings WHERE id=1) AND room=NEW.room AND seat=NEW.seat);
END;
CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, role TEXT NOT NULL CHECK(role IN('student','admin')), user_id TEXT, email TEXT, expires_at INTEGER NOT NULL);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE TABLE login_limits (key TEXT PRIMARY KEY, attempts INTEGER NOT NULL, expires_at INTEGER NOT NULL);
