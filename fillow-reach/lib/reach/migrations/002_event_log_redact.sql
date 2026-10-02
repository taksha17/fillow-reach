-- Allow pseudonymizing event_log.detail (PRD §6 data lifecycle) while keeping
-- every other column append-only. SQLite cannot do column-level GRANTs.

DROP TRIGGER IF EXISTS event_log_no_update;

CREATE TRIGGER event_log_no_update BEFORE UPDATE ON event_log
WHEN OLD.id IS NOT NEW.id
  OR OLD.ts IS NOT NEW.ts
  OR OLD.run_id IS NOT NEW.run_id
  OR OLD.agent IS NOT NEW.agent
  OR OLD.entity IS NOT NEW.entity
  OR OLD.entity_id IS NOT NEW.entity_id
  OR OLD.action IS NOT NEW.action
BEGIN
  SELECT RAISE(ABORT, 'event_log is append-only');
END;
