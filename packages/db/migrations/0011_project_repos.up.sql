-- 0011 Projects can be a git repository: cloned into the project's working
-- folder, worked on a branch, pushed with a token kept as a company secret.

ALTER TABLE projects
  ADD COLUMN repo_url    text,
  ADD COLUMN branch      text,
  ADD COLUMN repo_status text NOT NULL DEFAULT 'none' CHECK (repo_status IN ('none', 'cloned', 'failed')),
  ADD COLUMN repo_detail text NOT NULL DEFAULT '';
