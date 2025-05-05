-- Full schema for v1

-- Users table
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    handle VARCHAR(50) NOT NULL UNIQUE,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    display_name TEXT,
    bio TEXT,
    avatar_url TEXT,
    verified_at TIMESTAMPTZ,
    reset_password_token UUID,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT valid_handle CHECK (handle ~ '^[a-z0-9_-]+$')
);

-- Topics table
CREATE TABLE topics (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(50) NOT NULL,
    slug VARCHAR(50) NOT NULL,
    description TEXT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, slug)
);

-- Posts table
CREATE TABLE posts (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    topic_id INTEGER REFERENCES topics(id) ON DELETE SET NULL,
    slug VARCHAR(100),
    title TEXT,
    content TEXT NOT NULL,
    preview_text TEXT,
    image_url TEXT,
    status VARCHAR(20) DEFAULT 'public' NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT check_valid_status CHECK (status IN ('public', 'protected', 'draft', 'deleted')),
    UNIQUE(user_id, slug)
);

-- Subscribers table
CREATE TABLE subscribers (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    name TEXT,
    preferences TEXT DEFAULT 'single-post',
    last_sent_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    confirmed BOOLEAN DEFAULT false,
    confirmation_token UUID,
    unsubscribe_token UUID DEFAULT gen_random_uuid() NOT NULL,
    CONSTRAINT preferences_check CHECK (preferences IN ('single-post', 'digest')),
    CONSTRAINT valid_email CHECK (email ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'),
    UNIQUE(user_id, email)
);

-- Comments table
CREATE TABLE comments (
    id SERIAL PRIMARY KEY,
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    author TEXT NOT NULL,
    email TEXT,
    content TEXT NOT NULL,
    pinned BOOLEAN DEFAULT false,
    author_reply TEXT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Site settings table - for customization of each user's blog

CREATE TABLE sites (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    site_name TEXT NOT NULL,
    site_domain TEXT UNIQUE,
    theme VARCHAR(50) DEFAULT 'default',
    custom_css TEXT,
    custom_settings JSONB DEFAULT '{}',
    custom_domain BOOLEAN DEFAULT false,
    enable_comments BOOLEAN DEFAULT true,
    enable_subscriptions BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id)
);

-- Migrations!
-- the table should be created automatiicall by the migrate script
-- this one here is mostly for reference
CREATE TABLE IF NOT EXISTS migrations (
    id SERIAL PRIMARY KEY,
    filename TEXT NOT NULL UNIQUE,
    run_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes

CREATE INDEX idx_posts_user_id ON posts(user_id);
CREATE INDEX idx_posts_topic_id ON posts(topic_id);
CREATE INDEX idx_posts_status ON posts(status);
CREATE INDEX idx_topics_user_id ON topics(user_id);
CREATE INDEX idx_subscribers_user_id ON subscribers(user_id);
CREATE INDEX idx_subscribers_email ON subscribers(email);
CREATE INDEX idx_subscribers_confirmed ON subscribers(confirmed);
CREATE INDEX idx_comments_post_id ON comments(post_id);
