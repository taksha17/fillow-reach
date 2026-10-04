-- migration: external-transaction
-- Widen person.source to include 'linkedin_search' (people fetched through the
-- user's own logged-in browser session). SQLite cannot alter a CHECK, so the
-- table is rebuilt with the sanctioned rebuild pattern: FK off first (a
-- connection pragma — it cannot take effect inside a transaction, hence the
-- runner escape hatch), copy into a fresh table, drop the old WITHOUT cascades
-- (FK off), rename back. Children keep referencing the name 'person'.

PRAGMA foreign_keys = OFF;

BEGIN IMMEDIATE;

CREATE TABLE person_new (
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
                    ('apollo','hunter','job_posting','csv_import','manual','paste_import','public_page','linkedin_search')),
  relevance_score INTEGER CHECK (relevance_score BETWEEN 0 AND 100),
  relevance_reasons TEXT,                 -- JSON array of strings
  lifecycle       TEXT NOT NULL DEFAULT 'prospect' CHECK (lifecycle IN
                    ('prospect','invited','connected','messaged','replied','closed','suppressed')),
  do_not_contact  INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO person_new SELECT * FROM person;
DROP TABLE person;
ALTER TABLE person_new RENAME TO person;
CREATE INDEX idx_person_company ON person(company_id);
CREATE INDEX idx_person_lifecycle ON person(lifecycle);

INSERT INTO schema_version (version) VALUES (3);

COMMIT;

PRAGMA foreign_keys = ON;
