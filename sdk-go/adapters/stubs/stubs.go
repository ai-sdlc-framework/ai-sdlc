// Package stubs provides community adapter stub implementations.
package stubs

import (
	"context"
	"fmt"
	"strconv"
	"sync"

	"github.com/ai-sdlc-framework/ai-sdlc/sdk-go/adapters"
)

// ── Working stubs (unchanged) ────────────────────────────────────────

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

// ── In-memory stubs ──────────────────────────────────────────────────

// StubGitLabCI is an in-memory GitLab CI adapter.
type StubGitLabCI struct {
	mu      sync.Mutex
	builds  map[string]*adapters.PipelineRun
	nextID  int
}

func NewStubGitLabCI() *StubGitLabCI {
	return &StubGitLabCI{builds: make(map[string]*adapters.PipelineRun)}
}

func (s *StubGitLabCI) TriggerPipeline(ctx context.Context, repo, ref string, params map[string]string) (*adapters.PipelineRun, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.nextID++
	id := "gl-build-" + strconv.Itoa(s.nextID)
	run := &adapters.PipelineRun{ID: id, Status: "pending"}
	s.builds[id] = run
	return run, nil
}

func (s *StubGitLabCI) GetPipelineStatus(ctx context.Context, repo, runID string) (*adapters.PipelineRun, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	run, ok := s.builds[runID]
	if !ok {
		return nil, fmt.Errorf("pipeline run %s not found", runID)
	}
	return run, nil
}

func (s *StubGitLabCI) CancelPipeline(ctx context.Context, repo, runID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	run, ok := s.builds[runID]
	if !ok {
		return fmt.Errorf("pipeline run %s not found", runID)
	}
	run.Status = "cancelled"
	return nil
}

// GetBuildCount returns the number of builds for testing.
func (s *StubGitLabCI) GetBuildCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.builds)
}

// StubGitLabSource is an in-memory GitLab source control adapter.
type StubGitLabSource struct {
	mu       sync.Mutex
	branches map[string]string
	prs      map[string]*adapters.PullRequest
	files    map[string][]byte
	nextID   int
}

func NewStubGitLabSource() *StubGitLabSource {
	return &StubGitLabSource{
		branches: map[string]string{"main": "abc123"},
		prs:      make(map[string]*adapters.PullRequest),
		files:    make(map[string][]byte),
	}
}

func (s *StubGitLabSource) CreateBranch(ctx context.Context, repo, branch, fromRef string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, exists := s.branches[branch]; exists {
		return fmt.Errorf("branch %s already exists", branch)
	}
	sha, ok := s.branches[fromRef]
	if !ok {
		return fmt.Errorf("ref %s not found", fromRef)
	}
	s.branches[branch] = sha
	return nil
}

func (s *StubGitLabSource) CreatePullRequest(ctx context.Context, pr *adapters.PullRequest) (*adapters.PullRequest, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.nextID++
	id := "gl-mr-" + strconv.Itoa(s.nextID)
	created := &adapters.PullRequest{
		ID:           id,
		Title:        pr.Title,
		Description:  pr.Description,
		SourceBranch: pr.SourceBranch,
		TargetBranch: pr.TargetBranch,
		Status:       "open",
	}
	s.prs[id] = created
	return created, nil
}

func (s *StubGitLabSource) GetPullRequest(ctx context.Context, repo, id string) (*adapters.PullRequest, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	pr, ok := s.prs[id]
	if !ok {
		return nil, fmt.Errorf("pull request %s not found", id)
	}
	return pr, nil
}

func (s *StubGitLabSource) MergePullRequest(ctx context.Context, repo, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	pr, ok := s.prs[id]
	if !ok {
		return fmt.Errorf("pull request %s not found", id)
	}
	pr.Status = "merged"
	return nil
}

func (s *StubGitLabSource) GetFileContent(ctx context.Context, repo, path, ref string) ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := ref + ":" + path
	content, ok := s.files[key]
	if !ok {
		return nil, fmt.Errorf("file %s not found at ref %s", path, ref)
	}
	return content, nil
}

// GetPRCount returns the number of pull requests for testing.
func (s *StubGitLabSource) GetPRCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.prs)
}

// SetFile stores file content for testing.
func (s *StubGitLabSource) SetFile(ref, path string, content []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.files[ref+":" +path] = content
}

// StubJira is an in-memory Jira issue tracker.
type StubJira struct {
	mu       sync.Mutex
	issues   map[string]*adapters.Issue
	comments map[string][]string
	nextID   int
}

func NewStubJira() *StubJira {
	return &StubJira{
		issues:   make(map[string]*adapters.Issue),
		comments: make(map[string][]string),
	}
}

func (s *StubJira) GetIssue(ctx context.Context, id string) (*adapters.Issue, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	issue, ok := s.issues[id]
	if !ok {
		return nil, fmt.Errorf("issue %s not found", id)
	}
	return issue, nil
}

func (s *StubJira) CreateIssue(ctx context.Context, issue *adapters.Issue) (*adapters.Issue, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.nextID++
	id := "JIRA-" + strconv.Itoa(s.nextID)
	created := &adapters.Issue{
		ID:          id,
		Title:       issue.Title,
		Description: issue.Description,
		Status:      "open",
		Assignee:    issue.Assignee,
		Labels:      issue.Labels,
	}
	s.issues[id] = created
	return created, nil
}

func (s *StubJira) UpdateIssue(ctx context.Context, id string, updates map[string]interface{}) (*adapters.Issue, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	issue, ok := s.issues[id]
	if !ok {
		return nil, fmt.Errorf("issue %s not found", id)
	}
	if title, ok := updates["title"].(string); ok {
		issue.Title = title
	}
	if desc, ok := updates["description"].(string); ok {
		issue.Description = desc
	}
	if status, ok := updates["status"].(string); ok {
		issue.Status = status
	}
	if assignee, ok := updates["assignee"].(string); ok {
		issue.Assignee = assignee
	}
	return issue, nil
}

func (s *StubJira) AddComment(ctx context.Context, issueID, comment string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.issues[issueID]; !ok {
		return fmt.Errorf("issue %s not found", issueID)
	}
	s.comments[issueID] = append(s.comments[issueID], comment)
	return nil
}

func (s *StubJira) ListIssues(ctx context.Context, filter map[string]string) ([]*adapters.Issue, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var result []*adapters.Issue
	for _, issue := range s.issues {
		if status, ok := filter["status"]; ok && issue.Status != status {
			continue
		}
		result = append(result, issue)
	}
	return result, nil
}

// GetIssueCount returns the number of issues for testing.
func (s *StubJira) GetIssueCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.issues)
}

// GetStoredIssue returns a stored issue by ID for testing.
func (s *StubJira) GetStoredIssue(id string) *adapters.Issue {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.issues[id]
}

// GetComments returns comments for an issue for testing.
func (s *StubJira) GetComments(issueID string) []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.comments[issueID]
}

// StubBitbucket is an in-memory Bitbucket source control adapter.
type StubBitbucket struct {
	mu       sync.Mutex
	branches map[string]string
	prs      map[string]*adapters.PullRequest
	files    map[string][]byte
	nextID   int
}

func NewStubBitbucket() *StubBitbucket {
	return &StubBitbucket{
		branches: map[string]string{"main": "def456"},
		prs:      make(map[string]*adapters.PullRequest),
		files:    make(map[string][]byte),
	}
}

func (s *StubBitbucket) CreateBranch(ctx context.Context, repo, branch, fromRef string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, exists := s.branches[branch]; exists {
		return fmt.Errorf("branch %s already exists", branch)
	}
	sha, ok := s.branches[fromRef]
	if !ok {
		return fmt.Errorf("ref %s not found", fromRef)
	}
	s.branches[branch] = sha
	return nil
}

func (s *StubBitbucket) CreatePullRequest(ctx context.Context, pr *adapters.PullRequest) (*adapters.PullRequest, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.nextID++
	id := "bb-pr-" + strconv.Itoa(s.nextID)
	created := &adapters.PullRequest{
		ID:           id,
		Title:        pr.Title,
		Description:  pr.Description,
		SourceBranch: pr.SourceBranch,
		TargetBranch: pr.TargetBranch,
		Status:       "open",
	}
	s.prs[id] = created
	return created, nil
}

func (s *StubBitbucket) GetPullRequest(ctx context.Context, repo, id string) (*adapters.PullRequest, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	pr, ok := s.prs[id]
	if !ok {
		return nil, fmt.Errorf("pull request %s not found", id)
	}
	return pr, nil
}

func (s *StubBitbucket) MergePullRequest(ctx context.Context, repo, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	pr, ok := s.prs[id]
	if !ok {
		return fmt.Errorf("pull request %s not found", id)
	}
	pr.Status = "merged"
	return nil
}

func (s *StubBitbucket) GetFileContent(ctx context.Context, repo, path, ref string) ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := ref + ":" + path
	content, ok := s.files[key]
	if !ok {
		return nil, fmt.Errorf("file %s not found at ref %s", path, ref)
	}
	return content, nil
}

// GetPRCount returns the number of pull requests for testing.
func (s *StubBitbucket) GetPRCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.prs)
}

// SetFile stores file content for testing.
func (s *StubBitbucket) SetFile(ref, path string, content []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.files[ref+":"+path] = content
}
