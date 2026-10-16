CREATE TABLE login_nonces (nonce_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
CREATE INDEX login_nonces_expiry ON login_nonces(expires_at);
