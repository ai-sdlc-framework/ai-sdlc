package adapters

import (
	"context"
	"fmt"
)

// GitHubIssueTracker is a stub GitHub issue tracker.
type GitHubIssueTracker struct {
	Owner string
	Repo  string
	Token string
}

func NewGitHubIssueTracker(owner, repo, token string) *GitHubIssueTracker {
	return &GitHubIssueTracker{Owner: owner, Repo: repo, Token: token}
}

func (g *GitHubIssueTracker) GetIssue(ctx context.Context, id string) (*Issue, error) {
	return nil, fmt.Errorf("GitHubIssueTracker.GetIssue: not implemented")
}
func (g *GitHubIssueTracker) CreateIssue(ctx context.Context, issue *Issue) (*Issue, error) {
	return nil, fmt.Errorf("GitHubIssueTracker.CreateIssue: not implemented")
}
func (g *GitHubIssueTracker) UpdateIssue(ctx context.Context, id string, updates map[string]interface{}) (*Issue, error) {
	return nil, fmt.Errorf("GitHubIssueTracker.UpdateIssue: not implemented")
}
func (g *GitHubIssueTracker) AddComment(ctx context.Context, issueID, comment string) error {
	return fmt.Errorf("GitHubIssueTracker.AddComment: not implemented")
}
func (g *GitHubIssueTracker) ListIssues(ctx context.Context, filter map[string]string) ([]*Issue, error) {
	return nil, fmt.Errorf("GitHubIssueTracker.ListIssues: not implemented")
}

// GitHubSourceControl is a stub GitHub source control adapter.
type GitHubSourceControl struct {
	Owner string
	Repo  string
	Token string
}

func NewGitHubSourceControl(owner, repo, token string) *GitHubSourceControl {
	return &GitHubSourceControl{Owner: owner, Repo: repo, Token: token}
}

func (g *GitHubSourceControl) CreateBranch(ctx context.Context, repo, branchName, fromRef string) error {
	return fmt.Errorf("GitHubSourceControl.CreateBranch: not implemented")
}
func (g *GitHubSourceControl) CreatePullRequest(ctx context.Context, pr *PullRequest) (*PullRequest, error) {
	return nil, fmt.Errorf("GitHubSourceControl.CreatePullRequest: not implemented")
}
func (g *GitHubSourceControl) GetPullRequest(ctx context.Context, repo, id string) (*PullRequest, error) {
	return nil, fmt.Errorf("GitHubSourceControl.GetPullRequest: not implemented")
}
func (g *GitHubSourceControl) MergePullRequest(ctx context.Context, repo, id string) error {
	return fmt.Errorf("GitHubSourceControl.MergePullRequest: not implemented")
}
func (g *GitHubSourceControl) GetFileContent(ctx context.Context, repo, path, ref string) ([]byte, error) {
	return nil, fmt.Errorf("GitHubSourceControl.GetFileContent: not implemented")
}

// GitHubCIPipeline is a stub GitHub Actions CI adapter.
type GitHubCIPipeline struct {
	Owner string
	Repo  string
	Token string
}

func NewGitHubCIPipeline(owner, repo, token string) *GitHubCIPipeline {
	return &GitHubCIPipeline{Owner: owner, Repo: repo, Token: token}
}

func (g *GitHubCIPipeline) TriggerPipeline(ctx context.Context, repo, ref string, params map[string]string) (*PipelineRun, error) {
	return nil, fmt.Errorf("GitHubCIPipeline.TriggerPipeline: not implemented")
}
func (g *GitHubCIPipeline) GetPipelineStatus(ctx context.Context, repo, runID string) (*PipelineRun, error) {
	return nil, fmt.Errorf("GitHubCIPipeline.GetPipelineStatus: not implemented")
}
func (g *GitHubCIPipeline) CancelPipeline(ctx context.Context, repo, runID string) error {
	return fmt.Errorf("GitHubCIPipeline.CancelPipeline: not implemented")
}
