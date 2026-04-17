-- File/directory claims for coding-swarm coordination
CREATE TABLE IF NOT EXISTS file_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
  issue_id uuid REFERENCES issues(id) ON DELETE SET NULL,
  agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,
  run_id uuid REFERENCES heartbeat_runs(id) ON DELETE SET NULL,
  claim_type text NOT NULL CHECK (claim_type IN ('file', 'directory', 'glob')),
  claim_path text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released', 'expired')),
  expires_at timestamp with time zone NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX file_claims_company_project_idx ON file_claims (company_id, project_id);
CREATE INDEX file_claims_company_issue_idx ON file_claims (company_id, issue_id);
CREATE INDEX file_claims_company_agent_idx ON file_claims (company_id, agent_id);
CREATE INDEX file_claims_company_status_expires_idx ON file_claims (company_id, status, expires_at);
CREATE INDEX file_claims_path_idx ON file_claims (company_id, claim_path, status);
