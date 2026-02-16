package security

import "context"

// CodespacesClient is the interface for GitHub Codespaces operations.
type CodespacesClient interface {
	CreateCodespace(ctx context.Context, repo, branch string) (string, error)
	ExecuteInCodespace(ctx context.Context, codespaceID, command string) (string, error)
	DeleteCodespace(ctx context.Context, codespaceID string) error
}

// GitHubSandbox runs commands in a GitHub Codespace.
type GitHubSandbox struct {
	client      CodespacesClient
	repo        string
	branch      string
	codespaceID string
}

// NewGitHubSandbox creates a sandbox using GitHub Codespaces.
func NewGitHubSandbox(client CodespacesClient, repo, branch string) *GitHubSandbox {
	return &GitHubSandbox{client: client, repo: repo, branch: branch}
}

func (s *GitHubSandbox) Execute(ctx context.Context, command string, args []string) (*SandboxResult, error) {
	if s.codespaceID == "" {
		id, err := s.client.CreateCodespace(ctx, s.repo, s.branch)
		if err != nil {
			return nil, err
		}
		s.codespaceID = id
	}

	fullCmd := command
	for _, a := range args {
		fullCmd += " " + a
	}

	stdout, err := s.client.ExecuteInCodespace(ctx, s.codespaceID, fullCmd)
	if err != nil {
		return &SandboxResult{ExitCode: 1, Stderr: err.Error()}, nil
	}
	return &SandboxResult{ExitCode: 0, Stdout: stdout}, nil
}

func (s *GitHubSandbox) Cleanup(ctx context.Context) error {
	if s.codespaceID != "" {
		return s.client.DeleteCodespace(ctx, s.codespaceID)
	}
	return nil
}
