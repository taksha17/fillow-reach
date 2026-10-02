PRAGMA foreign_keys = ON;

CREATE TABLE schema_version (
  version    INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE company (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  name_norm   TEXT NOT NULL UNIQUE,
  domain      TEXT,
  linkedin_url TEXT,
  ats_source  TEXT,                       -- greenhouse | ashby | lever | workday
  blacklisted INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE person (
  id              INTEGER PRIMARY KEY,
  full_name       TEXT NOT NULL,
  first_name      TEXT,
  last_name       TEXT,
  headline        TEXT,                   -- untrusted text, never an LLM instruction
  title           TEXT,
  company_id      INTEGER REFERENCES company(id),
  linkedin_url    TEXT UNIQUE,            -- normalized
  location        TEXT,
  persona         TEXT NOT NULL CHECK (persona IN
                    ('recruiter','hiring_manager','senior_ic','executive','other')),
  source          TEXT NOT NULL CHECK (source IN
                    ('apollo','hunter','job_posting','csv_import','manual','paste_import','public_page')),
  relevance_score INTEGER CHECK (relevance_score BETWEEN 0 AND 100),
  relevance_reasons TEXT,                 -- JSON array of strings
  lifecycle       TEXT NOT NULL DEFAULT 'prospect' CHECK (lifecycle IN
                    ('prospect','invited','connected','messaged','replied','closed','suppressed')),
  do_not_contact  INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_person_company ON person(company_id);
CREATE INDEX idx_person_lifecycle ON person(lifecycle);

CREATE TABLE target_role (
  id            INTEGER PRIMARY KEY,
  job_ref       TEXT NOT NULL UNIQUE,     -- jobs.tsv "source:external_id"
  title         TEXT NOT NULL,
  company_id    INTEGER NOT NULL REFERENCES company(id),
  job_url       TEXT,
  tracker_id    INTEGER,                  -- row # in data/applications.md
  status        TEXT,                     -- mirrors tracker status
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE person_target (              -- many-to-many: why this person for this role
  person_id  INTEGER NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  target_id  INTEGER NOT NULL REFERENCES target_role(id) ON DELETE CASCADE,
  reason     TEXT,
  PRIMARY KEY (person_id, target_id)
);

CREATE TABLE connection (                 -- LinkedIn invite state, one row per person
  person_id     INTEGER PRIMARY KEY REFERENCES person(id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'none' CHECK (status IN
                  ('none','queued','sent','accepted','ignored','withdrawn',
                   'failed','already_connected')),
  queued_at     TEXT,
  sent_at       TEXT,
  accepted_at   TEXT,
  sent_via      TEXT CHECK (sent_via IN ('manual','bsk')),
  accepted_via  TEXT CHECK (accepted_via IN
                  ('notification_email','csv_import','bsk','manual')),
  last_checked_at TEXT,
  error         TEXT
);
CREATE INDEX idx_conn_sent ON connection(sent_at);

CREATE TABLE email_address (
  id            INTEGER PRIMARY KEY,
  person_id     INTEGER NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  email         TEXT NOT NULL,
  source        TEXT NOT NULL CHECK (source IN ('hunter','apollo','manual','pattern')),
  confidence    INTEGER,                  -- provider score 0-100
  verification  TEXT NOT NULL DEFAULT 'unknown' CHECK (verification IN
                  ('valid','invalid','accept_all','risky','unknown')),
  verified_at   TEXT,
  is_primary    INTEGER NOT NULL DEFAULT 0,
  provider_ref  TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (person_id, email)
);

CREATE TABLE resume_asset (               -- exact resume sent, for the daily report
  id         INTEGER PRIMARY KEY,
  job_ref    TEXT,
  path       TEXT NOT NULL,               -- data/tailored/...pdf
  sha256     TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE template (
  id      INTEGER PRIMARY KEY,
  kind    TEXT NOT NULL CHECK (kind IN ('linkedin_dm','email_first','email_followup','invite_note')),
  name    TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  body    TEXT NOT NULL,
  UNIQUE (kind, name, version)
);

CREATE TABLE message (
  id            INTEGER PRIMARY KEY,
  person_id     INTEGER NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  target_id     INTEGER REFERENCES target_role(id),
  channel       TEXT NOT NULL CHECK (channel IN ('linkedin','email')),
  direction     TEXT NOT NULL DEFAULT 'out' CHECK (direction IN ('out','in')),
  step          INTEGER NOT NULL DEFAULT 1,       -- 1 first touch, 2 follow-up
  status        TEXT NOT NULL CHECK (status IN
                  ('draft','needs_approval','approved','queued','sent',
                   'failed','bounced','replied','cancelled')),
  subject       TEXT,
  body          TEXT NOT NULL,
  template_id   INTEGER REFERENCES template(id),
  resume_asset_id INTEGER REFERENCES resume_asset(id),
  model         TEXT,
  grounding_ok  INTEGER,                          -- 1 pass, 0 blocked
  grounding_notes TEXT,
  approved_by   TEXT,                             -- 'user' | 'auto'
  approved_at   TEXT,
  scheduled_for TEXT,
  sent_at       TEXT,
  provider_ref  TEXT,                             -- SMTP message-id
  thread_ref    TEXT,                             -- Gmail thread id
  reply_class   TEXT CHECK (reply_class IN
                  ('positive','neutral','not_now','negative','auto_reply','unsubscribe')),
  error         TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_msg_sent ON message(channel, sent_at)
  WHERE direction = 'out' AND status = 'sent';
CREATE INDEX idx_msg_person ON message(person_id);

CREATE TABLE provider_usage (             -- quota tracking for the user's own API keys
  provider TEXT NOT NULL,                 -- hunter | apollo
  month    TEXT NOT NULL,                 -- YYYY-MM
  calls    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (provider, month)
);

CREATE TABLE enrichment_cache (           -- never pay twice for the same lookup
  provider   TEXT NOT NULL,
  query_key  TEXT NOT NULL,               -- e.g. 'email_finder:jane|doe|acme.com'
  response   TEXT NOT NULL,               -- JSON
  fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (provider, query_key)
);
-- API keys are never stored in the database; they live only in .env.

CREATE TABLE suppression (
  id         INTEGER PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('email','linkedin_url','domain')),
  value      TEXT NOT NULL,
  reason     TEXT NOT NULL CHECK (reason IN ('optout','bounce','manual','complaint')),
  added_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (kind, value)
);

CREATE TABLE run (
  id          INTEGER PRIMARY KEY,
  agent       TEXT NOT NULL,                      -- prospect | contacts | outreach | report
  started_at  TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  status      TEXT CHECK (status IN ('running','ok','partial','failed','paused')),
  dry_run     INTEGER NOT NULL DEFAULT 1,
  stats       TEXT                                -- JSON
);

CREATE TABLE report (
  id        INTEGER PRIMARY KEY,
  report_date TEXT NOT NULL UNIQUE,
  path      TEXT,
  sent_at   TEXT,
  status    TEXT CHECK (status IN ('built','sent','failed'))
);

-- Append-only audit trail: who did what, when, and why
CREATE TABLE event_log (
  id        INTEGER PRIMARY KEY,
  ts        TEXT NOT NULL DEFAULT (datetime('now')),
  run_id    INTEGER REFERENCES run(id),
  agent     TEXT NOT NULL,
  entity    TEXT NOT NULL,                        -- person | message | connection | email_address
  entity_id INTEGER,
  action    TEXT NOT NULL,
  detail    TEXT                                  -- JSON
);
CREATE TRIGGER event_log_no_update BEFORE UPDATE ON event_log
  BEGIN SELECT RAISE(ABORT, 'event_log is append-only'); END;
CREATE TRIGGER event_log_no_delete BEFORE DELETE ON event_log
  BEGIN SELECT RAISE(ABORT, 'event_log is append-only'); END;

-- Rolling-window usage, read by every sender before it sends
CREATE VIEW v_usage_7d AS
  SELECT 'invite' AS action, COUNT(*) AS used FROM connection
    WHERE sent_at >= datetime('now','-7 days')
  UNION ALL
  SELECT 'linkedin_message', COUNT(*) FROM message
    WHERE channel='linkedin' AND direction='out' AND status='sent'
      AND sent_at >= datetime('now','-7 days')
  UNION ALL
  SELECT 'email', COUNT(*) FROM message
    WHERE channel='email' AND direction='out' AND status='sent'
      AND sent_at >= datetime('now','-7 days');

CREATE VIEW IF NOT EXISTS v_usage_1d AS
  SELECT 'invite' AS action, COUNT(*) AS used FROM connection
    WHERE sent_at >= datetime('now','-1 day')
  UNION ALL
  SELECT 'linkedin_message', COUNT(*) FROM message
    WHERE channel='linkedin' AND direction='out' AND status='sent'
      AND sent_at >= datetime('now','-1 day')
  UNION ALL
  SELECT 'email', COUNT(*) FROM message
    WHERE channel='email' AND direction='out' AND status='sent'
      AND sent_at >= datetime('now','-1 day');
