// Package stubs provides community adapter stub implementations.
package stubs

import (
	"context"
	"fmt"

	"github.com/ai-sdlc-framework/ai-sdlc/sdk-go/adapters"
)

// StubCodeAnalysis is a stub code analysis adapter.
type StubCodeAnalysis struct{}

func NewStubCodeAnalysis() *StubCodeAnalysis { return &StubCodeAnalysis{} }

func (s *StubCodeAnalysis) Analyze(ctx context.Context, repo, ref string, rulesets []string) (*adapters.AnalysisResult, error) {
	return &adapters.AnalysisResult{Tool: "stub", Passed: true}, nil
}

// StubMessenger is a stub messenger adapter.
type StubMessenger struct{ Messages []*adapters.Message }

func NewStubMessenger() *StubMessenger { return &StubMessenger{} }

func (s *StubMessenger) Send(ctx context.Context, msg *adapters.Message) error {
	s.Messages = append(s.Messages, msg)
	return nil
}

// StubDeploymentTarget is a stub deployment target adapter.
type StubDeploymentTarget struct{}

func NewStubDeploymentTarget() *StubDeploymentTarget { return &StubDeploymentTarget{} }

func (s *StubDeploymentTarget) Deploy(ctx context.Context, env, artifact string, config map[string]string) (*adapters.Deployment, error) {
	return &adapters.Deployment{ID: "stub-deploy", Environment: env, Status: "success"}, nil
}
func (s *StubDeploymentTarget) GetDeploymentStatus(ctx context.Context, id string) (*adapters.Deployment, error) {
	return &adapters.Deployment{ID: id, Status: "success"}, nil
}
func (s *StubDeploymentTarget) Rollback(ctx context.Context, id string) error { return nil }

// StubGitLabCI is a stub GitLab CI adapter.
type StubGitLabCI struct{}

func NewStubGitLabCI() *StubGitLabCI { return &StubGitLabCI{} }

func (s *StubGitLabCI) TriggerPipeline(ctx context.Context, repo, ref string, params map[string]string) (*adapters.PipelineRun, error) {
	return nil, fmt.Errorf("StubGitLabCI: not implemented")
}
func (s *StubGitLabCI) GetPipelineStatus(ctx context.Context, repo, runID string) (*adapters.PipelineRun, error) {
	return nil, fmt.Errorf("StubGitLabCI: not implemented")
}
func (s *StubGitLabCI) CancelPipeline(ctx context.Context, repo, runID string) error {
	return fmt.Errorf("StubGitLabCI: not implemented")
}

// StubGitLabSource is a stub GitLab source control adapter.
type StubGitLabSource struct{}

func NewStubGitLabSource() *StubGitLabSource { return &StubGitLabSource{} }

func (s *StubGitLabSource) CreateBranch(ctx context.Context, repo, branch, fromRef string) error {
	return fmt.Errorf("StubGitLabSource: not implemented")
}
func (s *StubGitLabSource) CreatePullRequest(ctx context.Context, pr *adapters.PullRequest) (*adapters.PullRequest, error) {
	return nil, fmt.Errorf("StubGitLabSource: not implemented")
}
func (s *StubGitLabSource) GetPullRequest(ctx context.Context, repo, id string) (*adapters.PullRequest, error) {
	return nil, fmt.Errorf("StubGitLabSource: not implemented")
}
func (s *StubGitLabSource) MergePullRequest(ctx context.Context, repo, id string) error {
	return fmt.Errorf("StubGitLabSource: not implemented")
}
func (s *StubGitLabSource) GetFileContent(ctx context.Context, repo, path, ref string) ([]byte, error) {
	return nil, fmt.Errorf("StubGitLabSource: not implemented")
}

// StubJira is a stub Jira issue tracker.
type StubJira struct{}

func NewStubJira() *StubJira { return &StubJira{} }

func (s *StubJira) GetIssue(ctx context.Context, id string) (*adapters.Issue, error) {
	return nil, fmt.Errorf("StubJira: not implemented")
}
func (s *StubJira) CreateIssue(ctx context.Context, issue *adapters.Issue) (*adapters.Issue, error) {
	return nil, fmt.Errorf("StubJira: not implemented")
}
func (s *StubJira) UpdateIssue(ctx context.Context, id string, updates map[string]interface{}) (*adapters.Issue, error) {
	return nil, fmt.Errorf("StubJira: not implemented")
}
func (s *StubJira) AddComment(ctx context.Context, issueID, comment string) error {
	return fmt.Errorf("StubJira: not implemented")
}
func (s *StubJira) ListIssues(ctx context.Context, filter map[string]string) ([]*adapters.Issue, error) {
	return nil, fmt.Errorf("StubJira: not implemented")
}

// StubBitbucket is a stub Bitbucket source control adapter.
type StubBitbucket struct{}

func NewStubBitbucket() *StubBitbucket { return &StubBitbucket{} }

func (s *StubBitbucket) CreateBranch(ctx context.Context, repo, branch, fromRef string) error {
	return fmt.Errorf("StubBitbucket: not implemented")
}
func (s *StubBitbucket) CreatePullRequest(ctx context.Context, pr *adapters.PullRequest) (*adapters.PullRequest, error) {
	return nil, fmt.Errorf("StubBitbucket: not implemented")
}
func (s *StubBitbucket) GetPullRequest(ctx context.Context, repo, id string) (*adapters.PullRequest, error) {
	return nil, fmt.Errorf("StubBitbucket: not implemented")
}
func (s *StubBitbucket) MergePullRequest(ctx context.Context, repo, id string) error {
	return fmt.Errorf("StubBitbucket: not implemented")
}
func (s *StubBitbucket) GetFileContent(ctx context.Context, repo, path, ref string) ([]byte, error) {
	return nil, fmt.Errorf("StubBitbucket: not implemented")
}

// StubSonarQube is a stub SonarQube code analysis adapter.
type StubSonarQube struct{}

func NewStubSonarQube() *StubSonarQube { return &StubSonarQube{} }

func (s *StubSonarQube) Analyze(ctx context.Context, repo, ref string, rulesets []string) (*adapters.AnalysisResult, error) {
	return &adapters.AnalysisResult{Tool: "sonarqube", Passed: true}, nil
}

// StubSemgrep is a stub Semgrep code analysis adapter.
type StubSemgrep struct{}

func NewStubSemgrep() *StubSemgrep { return &StubSemgrep{} }

func (s *StubSemgrep) Analyze(ctx context.Context, repo, ref string, rulesets []string) (*adapters.AnalysisResult, error) {
	return &adapters.AnalysisResult{Tool: "semgrep", Passed: true}, nil
}
