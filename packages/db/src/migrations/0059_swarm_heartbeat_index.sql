-- Expression index for jsonb contextSnapshot ->> 'issueId' queries in heartbeat runs
-- Speeds up the hot-path query: WHERE contextSnapshot->>'issueId' = ${issueId}
CREATE INDEX IF NOT EXISTS idx_heartbeat_runs_context_issue
ON heartbeat_runs ((context_snapshot->>'issueId'))
WHERE context_snapshot IS NOT NULL;
