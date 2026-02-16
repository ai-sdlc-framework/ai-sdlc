package stubs

import (
	"context"
	"testing"

	"github.com/ai-sdlc-framework/ai-sdlc/sdk-go/adapters"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// ── StubGitLabCI ─────────────────────────────────────────────────────

func TestStubGitLabCI_TriggerAndGet(t *testing.T) {
	ci := NewStubGitLabCI()
	run, err := ci.TriggerPipeline(context.Background(), "repo", "main", nil)
	require.NoError(t, err)
	assert.Equal(t, "gl-build-1", run.ID)
	assert.Equal(t, "pending", run.Status)
	assert.Equal(t, 1, ci.GetBuildCount())

	got, err := ci.GetPipelineStatus(context.Background(), "repo", run.ID)
	require.NoError(t, err)
	assert.Equal(t, "pending", got.Status)
}

func TestStubGitLabCI_Cancel(t *testing.T) {
	ci := NewStubGitLabCI()
	run, _ := ci.TriggerPipeline(context.Background(), "repo", "main", nil)

	err := ci.CancelPipeline(context.Background(), "repo", run.ID)
	require.NoError(t, err)

	got, _ := ci.GetPipelineStatus(context.Background(), "repo", run.ID)
	assert.Equal(t, "cancelled", got.Status)
}

func TestStubGitLabCI_NotFound(t *testing.T) {
	ci := NewStubGitLabCI()
	_, err := ci.GetPipelineStatus(context.Background(), "repo", "nonexistent")
	assert.Error(t, err)

	err = ci.CancelPipeline(context.Background(), "repo", "nonexistent")
	assert.Error(t, err)
}

// ── StubGitLabSource ─────────────────────────────────────────────────

func TestStubGitLabSource_CreateBranch(t *testing.T) {
	sc := NewStubGitLabSource()
	err := sc.CreateBranch(context.Background(), "repo", "feature", "main")
	require.NoError(t, err)

	// Duplicate branch
	err = sc.CreateBranch(context.Background(), "repo", "feature", "main")
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "already exists")
}

func TestStubGitLabSource_CreateBranch_BadRef(t *testing.T) {
	sc := NewStubGitLabSource()
	err := sc.CreateBranch(context.Background(), "repo", "feature", "nonexistent")
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "not found")
}

func TestStubGitLabSource_PullRequestLifecycle(t *testing.T) {
	sc := NewStubGitLabSource()
	sc.CreateBranch(context.Background(), "repo", "feature", "main")

	pr, err := sc.CreatePullRequest(context.Background(), &adapters.PullRequest{
		Title: "Test MR", SourceBranch: "feature", TargetBranch: "main",
	})
	require.NoError(t, err)
	assert.Equal(t, "gl-mr-1", pr.ID)
	assert.Equal(t, "open", pr.Status)
	assert.Equal(t, 1, sc.GetPRCount())

	got, err := sc.GetPullRequest(context.Background(), "repo", pr.ID)
	require.NoError(t, err)
	assert.Equal(t, "Test MR", got.Title)

	err = sc.MergePullRequest(context.Background(), "repo", pr.ID)
	require.NoError(t, err)

	got, _ = sc.GetPullRequest(context.Background(), "repo", pr.ID)
	assert.Equal(t, "merged", got.Status)
}

func TestStubGitLabSource_GetFileContent(t *testing.T) {
	sc := NewStubGitLabSource()
	sc.SetFile("main", "README.md", []byte("hello"))

	content, err := sc.GetFileContent(context.Background(), "repo", "README.md", "main")
	require.NoError(t, err)
	assert.Equal(t, "hello", string(content))
}

func TestStubGitLabSource_GetFileContent_NotFound(t *testing.T) {
	sc := NewStubGitLabSource()
	_, err := sc.GetFileContent(context.Background(), "repo", "missing.txt", "main")
	assert.Error(t, err)
}

func TestStubGitLabSource_PRNotFound(t *testing.T) {
	sc := NewStubGitLabSource()
	_, err := sc.GetPullRequest(context.Background(), "repo", "nonexistent")
	assert.Error(t, err)

	err = sc.MergePullRequest(context.Background(), "repo", "nonexistent")
	assert.Error(t, err)
}

// ── StubJira ─────────────────────────────────────────────────────────

func TestStubJira_CreateAndGet(t *testing.T) {
	jira := NewStubJira()
	created, err := jira.CreateIssue(context.Background(), &adapters.Issue{
		Title: "Bug Report", Description: "It's broken", Assignee: "bob",
	})
	require.NoError(t, err)
	assert.Equal(t, "JIRA-1", created.ID)
	assert.Equal(t, "open", created.Status)
	assert.Equal(t, 1, jira.GetIssueCount())

	got, err := jira.GetIssue(context.Background(), created.ID)
	require.NoError(t, err)
	assert.Equal(t, "Bug Report", got.Title)
	assert.Equal(t, "bob", got.Assignee)
}

func TestStubJira_UpdateIssue(t *testing.T) {
	jira := NewStubJira()
	created, _ := jira.CreateIssue(context.Background(), &adapters.Issue{Title: "Task"})

	updated, err := jira.UpdateIssue(context.Background(), created.ID, map[string]interface{}{
		"title":  "Updated Task",
		"status": "done",
	})
	require.NoError(t, err)
	assert.Equal(t, "Updated Task", updated.Title)
	assert.Equal(t, "done", updated.Status)

	stored := jira.GetStoredIssue(created.ID)
	assert.Equal(t, "Updated Task", stored.Title)
}

func TestStubJira_AddComment(t *testing.T) {
	jira := NewStubJira()
	created, _ := jira.CreateIssue(context.Background(), &adapters.Issue{Title: "Task"})

	err := jira.AddComment(context.Background(), created.ID, "First comment")
	require.NoError(t, err)
	err = jira.AddComment(context.Background(), created.ID, "Second comment")
	require.NoError(t, err)

	comments := jira.GetComments(created.ID)
	assert.Len(t, comments, 2)
	assert.Equal(t, "First comment", comments[0])
}

func TestStubJira_AddComment_NotFound(t *testing.T) {
	jira := NewStubJira()
	err := jira.AddComment(context.Background(), "JIRA-999", "test")
	assert.Error(t, err)
}

func TestStubJira_ListIssues(t *testing.T) {
	jira := NewStubJira()
	jira.CreateIssue(context.Background(), &adapters.Issue{Title: "Open One"})
	created2, _ := jira.CreateIssue(context.Background(), &adapters.Issue{Title: "Closed One"})
	jira.UpdateIssue(context.Background(), created2.ID, map[string]interface{}{"status": "closed"})

	all, err := jira.ListIssues(context.Background(), nil)
	require.NoError(t, err)
	assert.Len(t, all, 2)

	open, err := jira.ListIssues(context.Background(), map[string]string{"status": "open"})
	require.NoError(t, err)
	assert.Len(t, open, 1)
}

func TestStubJira_NotFound(t *testing.T) {
	jira := NewStubJira()
	_, err := jira.GetIssue(context.Background(), "JIRA-999")
	assert.Error(t, err)

	_, err = jira.UpdateIssue(context.Background(), "JIRA-999", nil)
	assert.Error(t, err)
}

// ── StubBitbucket ────────────────────────────────────────────────────

func TestStubBitbucket_CreateBranch(t *testing.T) {
	bb := NewStubBitbucket()
	err := bb.CreateBranch(context.Background(), "repo", "feature", "main")
	require.NoError(t, err)

	err = bb.CreateBranch(context.Background(), "repo", "feature", "main")
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "already exists")
}

func TestStubBitbucket_PullRequestLifecycle(t *testing.T) {
	bb := NewStubBitbucket()

	pr, err := bb.CreatePullRequest(context.Background(), &adapters.PullRequest{
		Title: "Test PR", SourceBranch: "feature", TargetBranch: "main",
	})
	require.NoError(t, err)
	assert.Equal(t, "bb-pr-1", pr.ID)
	assert.Equal(t, "open", pr.Status)
	assert.Equal(t, 1, bb.GetPRCount())

	got, err := bb.GetPullRequest(context.Background(), "repo", pr.ID)
	require.NoError(t, err)
	assert.Equal(t, "Test PR", got.Title)

	err = bb.MergePullRequest(context.Background(), "repo", pr.ID)
	require.NoError(t, err)

	got, _ = bb.GetPullRequest(context.Background(), "repo", pr.ID)
	assert.Equal(t, "merged", got.Status)
}

func TestStubBitbucket_GetFileContent(t *testing.T) {
	bb := NewStubBitbucket()
	bb.SetFile("main", "file.txt", []byte("content"))

	data, err := bb.GetFileContent(context.Background(), "repo", "file.txt", "main")
	require.NoError(t, err)
	assert.Equal(t, "content", string(data))
}

func TestStubBitbucket_PRNotFound(t *testing.T) {
	bb := NewStubBitbucket()
	_, err := bb.GetPullRequest(context.Background(), "repo", "nonexistent")
	assert.Error(t, err)

	err = bb.MergePullRequest(context.Background(), "repo", "nonexistent")
	assert.Error(t, err)
}

// ── Existing stubs still work ────────────────────────────────────────

func TestStubCodeAnalysis(t *testing.T) {
	ca := NewStubCodeAnalysis()
	result, err := ca.Analyze(context.Background(), "repo", "main", nil)
	require.NoError(t, err)
	assert.True(t, result.Passed)
	assert.Equal(t, "stub", result.Tool)
}

func TestStubMessenger(t *testing.T) {
	m := NewStubMessenger()
	err := m.Send(context.Background(), &adapters.Message{Title: "Hello", Body: "World"})
	require.NoError(t, err)
	assert.Len(t, m.Messages, 1)
	assert.Equal(t, "Hello", m.Messages[0].Title)
}

func TestStubDeploymentTarget(t *testing.T) {
	dt := NewStubDeploymentTarget()
	dep, err := dt.Deploy(context.Background(), "staging", "app.tar", nil)
	require.NoError(t, err)
	assert.Equal(t, "success", dep.Status)

	status, err := dt.GetDeploymentStatus(context.Background(), dep.ID)
	require.NoError(t, err)
	assert.Equal(t, "success", status.Status)

	assert.NoError(t, dt.Rollback(context.Background(), dep.ID))
}
