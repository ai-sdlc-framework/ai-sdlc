package adapters

import (
	"context"
	"encoding/base64"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const (
	defaultGitHubBaseURL = "https://api.github.com"
	githubAcceptHeader   = "application/vnd.github.v3+json"
)

func githubHeaders(token string) map[string]string {
	return map[string]string{
		"Authorization": "Bearer " + token,
		"Accept":        githubAcceptHeader,
	}
}

// ── GitHub API response types ────────────────────────────────────────

type githubIssue struct {
	Number      int           `json:"number"`
	Title       string        `json:"title"`
	Body        string        `json:"body"`
	State       string        `json:"state"`
	HTMLURL     string        `json:"html_url"`
	Assignee    *githubUser   `json:"assignee"`
	Labels      []githubLabel `json:"labels"`
	PullRequest *struct{}     `json:"pull_request"`
}

type githubUser struct {
	Login string `json:"login"`
}

type githubLabel struct {
	Name string `json:"name"`
}

type githubComment struct {
	ID int `json:"id"`
}

type githubRef struct {
	Object struct {
		SHA string `json:"sha"`
	} `json:"object"`
}

type githubPull struct {
	Number  int    `json:"number"`
	Title   string `json:"title"`
	Body    string `json:"body"`
	State   string `json:"state"`
	Merged  bool   `json:"merged"`
	HTMLURL string `json:"html_url"`
	Head    struct {
		Ref string `json:"ref"`
	} `json:"head"`
	Base struct {
		Ref string `json:"ref"`
	} `json:"base"`
}

type githubContent struct {
	Content  string `json:"content"`
	Encoding string `json:"encoding"`
}

type githubWorkflowRun struct {
	ID         int    `json:"id"`
	Status     string `json:"status"`
	Conclusion string `json:"conclusion"`
	HTMLURL    string `json:"html_url"`
}

type githubWorkflowRuns struct {
	WorkflowRuns []githubWorkflowRun `json:"workflow_runs"`
}

// ── GitHubIssueTracker ───────────────────────────────────────────────

// GitHubIssueTracker implements IssueTracker using the GitHub REST API.
type GitHubIssueTracker struct {
	Owner   string
	Repo    string
	Token   string
	BaseURL string
	Client  HTTPClient
}

// NewGitHubIssueTracker creates a new GitHub issue tracker.
func NewGitHubIssueTracker(owner, repo, token string) *GitHubIssueTracker {
	return &GitHubIssueTracker{
		Owner:   owner,
		Repo:    repo,
		Token:   token,
		BaseURL: defaultGitHubBaseURL,
		Client:  http.DefaultClient,
	}
}

func (g *GitHubIssueTracker) apiURL(path string) string {
	return fmt.Sprintf("%s/repos/%s/%s%s", g.BaseURL, g.Owner, g.Repo, path)
}

func mapGitHubIssue(gi *githubIssue) *Issue {
	issue := &Issue{
		ID:          strconv.Itoa(gi.Number),
		Title:       gi.Title,
		Description: gi.Body,
		Status:      gi.State,
		URL:         gi.HTMLURL,
	}
	if gi.Assignee != nil {
		issue.Assignee = gi.Assignee.Login
	}
	for _, l := range gi.Labels {
		issue.Labels = append(issue.Labels, l.Name)
	}
	return issue
}

func (g *GitHubIssueTracker) ListIssues(ctx context.Context, filter map[string]string) ([]*Issue, error) {
	url := g.apiURL("/issues?per_page=100")
	if state, ok := filter["state"]; ok {
		url += "&state=" + state
	}
	if labels, ok := filter["labels"]; ok {
		url += "&labels=" + labels
	}
	if assignee, ok := filter["assignee"]; ok {
		url += "&assignee=" + assignee
	}

	ghIssues, err := doJSON[[]githubIssue](ctx, g.Client, http.MethodGet, url, nil, githubHeaders(g.Token))
	if err != nil {
		return nil, fmt.Errorf("list issues: %w", err)
	}

	var issues []*Issue
	for i := range ghIssues {
		// GitHub's issues endpoint also returns pull requests; filter them out.
		if ghIssues[i].PullRequest != nil {
			continue
		}
		issues = append(issues, mapGitHubIssue(&ghIssues[i]))
	}
	return issues, nil
}

func (g *GitHubIssueTracker) GetIssue(ctx context.Context, id string) (*Issue, error) {
	url := g.apiURL("/issues/" + id)
	gi, err := doJSON[githubIssue](ctx, g.Client, http.MethodGet, url, nil, githubHeaders(g.Token))
	if err != nil {
		return nil, fmt.Errorf("get issue %s: %w", id, err)
	}
	return mapGitHubIssue(&gi), nil
}

func (g *GitHubIssueTracker) CreateIssue(ctx context.Context, issue *Issue) (*Issue, error) {
	url := g.apiURL("/issues")
	body := map[string]interface{}{
		"title": issue.Title,
		"body":  issue.Description,
	}
	if len(issue.Labels) > 0 {
		body["labels"] = issue.Labels
	}
	if issue.Assignee != "" {
		body["assignees"] = []string{issue.Assignee}
	}

	gi, err := doJSON[githubIssue](ctx, g.Client, http.MethodPost, url, body, githubHeaders(g.Token))
	if err != nil {
		return nil, fmt.Errorf("create issue: %w", err)
	}
	return mapGitHubIssue(&gi), nil
}

func (g *GitHubIssueTracker) UpdateIssue(ctx context.Context, id string, updates map[string]interface{}) (*Issue, error) {
	url := g.apiURL("/issues/" + id)
	gi, err := doJSON[githubIssue](ctx, g.Client, http.MethodPatch, url, updates, githubHeaders(g.Token))
	if err != nil {
		return nil, fmt.Errorf("update issue %s: %w", id, err)
	}
	return mapGitHubIssue(&gi), nil
}

func (g *GitHubIssueTracker) AddComment(ctx context.Context, issueID, comment string) error {
	url := g.apiURL("/issues/" + issueID + "/comments")
	body := map[string]string{"body": comment}
	_, err := doJSON[githubComment](ctx, g.Client, http.MethodPost, url, body, githubHeaders(g.Token))
	if err != nil {
		return fmt.Errorf("add comment to issue %s: %w", issueID, err)
	}
	return nil
}

// ── GitHubSourceControl ──────────────────────────────────────────────

// GitHubSourceControl implements SourceControl using the GitHub REST API.
type GitHubSourceControl struct {
	Owner   string
	Repo    string
	Token   string
	BaseURL string
	Client  HTTPClient
}

// NewGitHubSourceControl creates a new GitHub source control adapter.
func NewGitHubSourceControl(owner, repo, token string) *GitHubSourceControl {
	return &GitHubSourceControl{
		Owner:   owner,
		Repo:    repo,
		Token:   token,
		BaseURL: defaultGitHubBaseURL,
		Client:  http.DefaultClient,
	}
}

func (g *GitHubSourceControl) apiURL(path string) string {
	return fmt.Sprintf("%s/repos/%s/%s%s", g.BaseURL, g.Owner, g.Repo, path)
}

func (g *GitHubSourceControl) CreateBranch(ctx context.Context, repo, branchName, fromRef string) error {
	// Get the SHA of the source ref.
	refURL := g.apiURL("/git/ref/heads/" + fromRef)
	ref, err := doJSON[githubRef](ctx, g.Client, http.MethodGet, refURL, nil, githubHeaders(g.Token))
	if err != nil {
		return fmt.Errorf("get ref %s: %w", fromRef, err)
	}

	// Create the new ref.
	createURL := g.apiURL("/git/refs")
	body := map[string]string{
		"ref": "refs/heads/" + branchName,
		"sha": ref.Object.SHA,
	}
	_, err = doJSON[githubRef](ctx, g.Client, http.MethodPost, createURL, body, githubHeaders(g.Token))
	if err != nil {
		// 422 means the ref already exists.
		if apiErr, ok := err.(*APIError); ok && apiErr.StatusCode == http.StatusUnprocessableEntity {
			return fmt.Errorf("branch %s already exists", branchName)
		}
		return fmt.Errorf("create branch %s: %w", branchName, err)
	}
	return nil
}

func (g *GitHubSourceControl) CreatePullRequest(ctx context.Context, pr *PullRequest) (*PullRequest, error) {
	url := g.apiURL("/pulls")
	body := map[string]string{
		"title": pr.Title,
		"body":  pr.Description,
		"head":  pr.SourceBranch,
		"base":  pr.TargetBranch,
	}

	ghPR, err := doJSON[githubPull](ctx, g.Client, http.MethodPost, url, body, githubHeaders(g.Token))
	if err != nil {
		return nil, fmt.Errorf("create pull request: %w", err)
	}
	return mapGitHubPull(&ghPR), nil
}

func (g *GitHubSourceControl) GetPullRequest(ctx context.Context, repo, id string) (*PullRequest, error) {
	url := g.apiURL("/pulls/" + id)
	ghPR, err := doJSON[githubPull](ctx, g.Client, http.MethodGet, url, nil, githubHeaders(g.Token))
	if err != nil {
		return nil, fmt.Errorf("get pull request %s: %w", id, err)
	}
	return mapGitHubPull(&ghPR), nil
}

func (g *GitHubSourceControl) MergePullRequest(ctx context.Context, repo, id string) error {
	url := g.apiURL("/pulls/" + id + "/merge")
	resp, err := doRequest(ctx, g.Client, http.MethodPut, url, map[string]string{}, githubHeaders(g.Token))
	if err != nil {
		return fmt.Errorf("merge pull request %s: %w", id, err)
	}
	defer resp.Body.Close()
	if err := checkResponse(resp); err != nil {
		return fmt.Errorf("merge pull request %s: %w", id, err)
	}
	return nil
}

func (g *GitHubSourceControl) GetFileContent(ctx context.Context, repo, path, ref string) ([]byte, error) {
	url := g.apiURL("/contents/" + path)
	if ref != "" {
		url += "?ref=" + ref
	}

	gc, err := doJSON[githubContent](ctx, g.Client, http.MethodGet, url, nil, githubHeaders(g.Token))
	if err != nil {
		return nil, fmt.Errorf("get file content %s: %w", path, err)
	}

	// GitHub returns base64-encoded content with possible newlines.
	cleaned := strings.ReplaceAll(gc.Content, "\n", "")
	data, err := base64.StdEncoding.DecodeString(cleaned)
	if err != nil {
		return nil, fmt.Errorf("decode base64 content for %s: %w", path, err)
	}
	return data, nil
}

func mapGitHubPull(ghPR *githubPull) *PullRequest {
	status := "open"
	if ghPR.Merged {
		status = "merged"
	} else if ghPR.State == "closed" {
		status = "closed"
	}
	return &PullRequest{
		ID:           strconv.Itoa(ghPR.Number),
		Title:        ghPR.Title,
		Description:  ghPR.Body,
		SourceBranch: ghPR.Head.Ref,
		TargetBranch: ghPR.Base.Ref,
		Status:       status,
		URL:          ghPR.HTMLURL,
	}
}

// ── GitHubCIPipeline ─────────────────────────────────────────────────

// GitHubCIPipeline implements CIPipeline using the GitHub Actions REST API.
type GitHubCIPipeline struct {
	Owner   string
	Repo    string
	Token   string
	BaseURL string
	Client  HTTPClient
}

// NewGitHubCIPipeline creates a new GitHub Actions CI adapter.
func NewGitHubCIPipeline(owner, repo, token string) *GitHubCIPipeline {
	return &GitHubCIPipeline{
		Owner:   owner,
		Repo:    repo,
		Token:   token,
		BaseURL: defaultGitHubBaseURL,
		Client:  http.DefaultClient,
	}
}

func (g *GitHubCIPipeline) apiURL(path string) string {
	return fmt.Sprintf("%s/repos/%s/%s%s", g.BaseURL, g.Owner, g.Repo, path)
}

func (g *GitHubCIPipeline) TriggerPipeline(ctx context.Context, repo, ref string, params map[string]string) (*PipelineRun, error) {
	// Dispatch the workflow.
	dispatchURL := g.apiURL("/actions/workflows/" + repo + "/dispatches")
	body := map[string]interface{}{
		"ref":    ref,
		"inputs": params,
	}
	resp, err := doRequest(ctx, g.Client, http.MethodPost, dispatchURL, body, githubHeaders(g.Token))
	if err != nil {
		return nil, fmt.Errorf("trigger pipeline: %w", err)
	}
	if err := checkResponse(resp); err != nil {
		return nil, fmt.Errorf("trigger pipeline: %w", err)
	}
	resp.Body.Close()

	// Brief pause then poll for the newest run.
	time.Sleep(2 * time.Second)

	runsURL := g.apiURL("/actions/runs?per_page=1")
	runs, err := doJSON[githubWorkflowRuns](ctx, g.Client, http.MethodGet, runsURL, nil, githubHeaders(g.Token))
	if err != nil {
		return nil, fmt.Errorf("poll pipeline runs: %w", err)
	}
	if len(runs.WorkflowRuns) == 0 {
		return &PipelineRun{ID: "unknown", Status: "pending"}, nil
	}

	run := runs.WorkflowRuns[0]
	return &PipelineRun{
		ID:     strconv.Itoa(run.ID),
		Status: mapGitHubRunStatus(run.Status, run.Conclusion),
		URL:    run.HTMLURL,
	}, nil
}

func (g *GitHubCIPipeline) GetPipelineStatus(ctx context.Context, repo, runID string) (*PipelineRun, error) {
	url := g.apiURL("/actions/runs/" + runID)
	run, err := doJSON[githubWorkflowRun](ctx, g.Client, http.MethodGet, url, nil, githubHeaders(g.Token))
	if err != nil {
		return nil, fmt.Errorf("get pipeline status %s: %w", runID, err)
	}
	return &PipelineRun{
		ID:     strconv.Itoa(run.ID),
		Status: mapGitHubRunStatus(run.Status, run.Conclusion),
		URL:    run.HTMLURL,
	}, nil
}

func (g *GitHubCIPipeline) CancelPipeline(ctx context.Context, repo, runID string) error {
	url := g.apiURL("/actions/runs/" + runID + "/cancel")
	resp, err := doRequest(ctx, g.Client, http.MethodPost, url, nil, githubHeaders(g.Token))
	if err != nil {
		return fmt.Errorf("cancel pipeline %s: %w", runID, err)
	}
	if err := checkResponse(resp); err != nil {
		return fmt.Errorf("cancel pipeline %s: %w", runID, err)
	}
	resp.Body.Close()
	return nil
}

func mapGitHubRunStatus(status, conclusion string) string {
	switch status {
	case "queued":
		return "pending"
	case "in_progress":
		return "running"
	case "completed":
		switch conclusion {
		case "success":
			return "succeeded"
		case "failure":
			return "failed"
		case "cancelled":
			return "cancelled"
		default:
			return "failed"
		}
	default:
		return "unknown"
	}
}
