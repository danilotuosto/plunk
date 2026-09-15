-- Backfill a default, enabled SES provider row for every existing project.
--
-- The `project_email_providers` table is empty after the migration that created it,
-- so pre-existing SES-only projects would have 0 provider rows and every email would
-- hit the "no enabled providers" exhaustion path. This gives each existing project a
-- priority-0 SES row (SES is the historic default that used env credentials), so
-- existing behaviour is preserved after the multi-provider change.
--
-- New projects get their SES row at creation time (see Users.createProject), so this
-- only needs to cover projects that already exist.
--
-- Cost: a sequential scan of "projects" guarded by a NOT EXISTS anti-join against
-- "project_email_providers" — cheap, and idempotent (re-running inserts nothing new).
INSERT INTO "project_email_providers" ("id", "projectId", "provider", "enabled", "priority", "createdAt", "updatedAt")
SELECT gen_random_uuid(), p."id", 'SES', true, 0, now(), now()
FROM "projects" p
WHERE NOT EXISTS (
  SELECT 1 FROM "project_email_providers" pep
  WHERE pep."projectId" = p."id" AND pep."provider" = 'SES'
);
