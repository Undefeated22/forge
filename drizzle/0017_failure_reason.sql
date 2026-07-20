-- Why an analysis failed, on the report itself.
--
-- Two real uploads sat at `status = 'failed'` with no explanation anywhere a
-- user could reach: the cause (a 413, because the prompt was built against a
-- constant sized for a different provider) existed only in worker stdout. The
-- operator had to ask someone to read the logs to find out.
--
-- A failure state that cannot explain itself is barely better than a hang.

ALTER TABLE "reports" ADD COLUMN IF NOT EXISTS "failure_reason" text;
