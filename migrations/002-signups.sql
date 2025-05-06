
-- migrations/002-pending-signups.sql

CREATE TABLE pending_signups (
    id SERIAL PRIMARY KEY,
    handle VARCHAR(50) NOT NULL,
    email TEXT NOT NULL,
    verification_code VARCHAR(6) NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT valid_handle CHECK (handle ~ '^[a-z0-9_-]+$'),
    CONSTRAINT valid_email CHECK (email ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'),
    -- These fields should be unique since they'll be transferred to users table
    UNIQUE(handle),
    UNIQUE(email)
);

-- Index for quick lookups
CREATE INDEX idx_pending_signups_verification_code ON pending_signups(verification_code);

-- Function to clean up expired pending signups
CREATE OR REPLACE FUNCTION cleanup_expired_pending_signups()
RETURNS void AS $$
BEGIN
    DELETE FROM pending_signups WHERE expires_at < NOW();
END;
$$ LANGUAGE plpgsql;
