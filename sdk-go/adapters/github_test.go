package adapters

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func newTestGitHubIssueTracker(srv *httptest.Server) *GitHubIssueTracker {
	return &GitHubIssueTracker{
		Owner:   "test-owner",
		Repo:    "test-repo",
		Token:   "test-token",
		BaseURL: srv.URL,
		Client:  srv.Client(),
	}
}

func newTestGitHubSourceControl(srv *httptest.Server) *GitHubSourceControl {
	return &GitHubSourceControl{
		Owner:   "test-owner",
		Repo:    "test-repo",
		Token:   "test-token",
		BaseURL: srv.URL,
		Client:  srv.Client(),
	}
}

func newTestGitHubCIPipeline(srv *httptest.Server) *GitHubCIPipeline {
	return &GitHubCIPipeline{
		Owner:   "test-owner",
		Repo:    "test-repo",
		Token:   "test-token",
		BaseURL: srv.URL,
		Client:  srv.Client(),
	}
}

// ── IssueTracker tests ───────────────────────────────────────────────

func TestGitHubIssueTracker_ListIssues(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "Bearer test-token", r.Header.Get("Authorization"))
		assert.Contains(t, r.URL.Path, "/repos/test-owner/test-repo/issues")
		assert.Equal(t, "100", r.URL.Query().Get("per_page"))

		json.NewEncoder(w).Encode([]githubIssue{
			{Number: 1, Title: "Bug", State: "open", Labels: []githubLabel{{Name: "bug"}}},
			{Number: 2, Title: "PR", State: "open", PullRequest: &struct{}{}}, // should be filtered
			{Number: 3, Title: "Feature", State: "open", Assignee: &githubUser{Login: "alice"}},
		})
	}))
	defer srv.Close()

	tracker := newTestGitHubIssueTracker(srv)
	issues, err := tracker.ListIssues(context.Background(), nil)
	require.NoError(t, err)
	assert.Len(t, issues, 2) // PR filtered out
	assert.Equal(t, "1", issues[0].ID)
	assert.Equal(t, "Bug", issues[0].Title)
	assert.Equal(t, []string{"bug"}, issues[0].Labels)
	assert.Equal(t, "3", issues[1].ID)
	assert.Equal(t, "alice", issues[1].Assignee)
}

func TestGitHubIssueTracker_GetIssue(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Contains(t, r.URL.Path, "/issues/42")
		json.NewEncoder(w).Encode(githubIssue{
			Number: 42, Title: "Test Issue", Body: "Description", State: "open",
			HTMLURL: "https://github.com/test/42",
		})
	}))
	defer srv.Close()

	tracker := newTestGitHubIssueTracker(srv)
	issue, err := tracker.GetIssue(context.Background(), "42")
	require.NoError(t, err)
	assert.Equal(t, "42", issue.ID)
	assert.Equal(t, "Test Issue", issue.Title)
	assert.Equal(t, "Description", issue.Description)
	assert.Equal(t, "open", issue.Status)
}

func TestGitHubIssueTracker_CreateIssue(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, http.MethodPost, r.Method)

		var body map[string]interface{}
		json.NewDecoder(r.Body).Decode(&body)
		assert.Equal(t, "New Issue", body["title"])
		assert.Equal(t, "Body text", body["body"])

		w.WriteHeader(201)
		json.NewEncoder(w).Encode(githubIssue{
			Number: 99, Title: "New Issue", Body: "Body text", State: "open",
		})
	}))
	defer srv.Close()

	tracker := newTestGitHubIssueTracker(srv)
	issue, err := tracker.CreateIssue(context.Background(), &Issue{
		Title: "New Issue", Description: "Body text",
	})
	require.NoError(t, err)
	assert.Equal(t, "99", issue.ID)
	assert.Equal(t, "New Issue", issue.Title)
}

func TestGitHubIssueTracker_UpdateIssue(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, http.MethodPatch, r.Method)
		assert.Contains(t, r.URL.Path, "/issues/10")

		json.NewEncoder(w).Encode(githubIssue{
			Number: 10, Title: "Updated", State: "closed",
		})
	}))
	defer srv.Close()

	tracker := newTestGitHubIssueTracker(srv)
	issue, err := tracker.UpdateIssue(context.Background(), "10", map[string]interface{}{"state": "closed"})
	require.NoError(t, err)
	assert.Equal(t, "closed", issue.Status)
}

func TestGitHubIssueTracker_AddComment(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, http.MethodPost, r.Method)
		assert.Contains(t, r.URL.Path, "/issues/5/comments")

		var body map[string]string
		json.NewDecoder(r.Body).Decode(&body)
		assert.Equal(t, "Nice work!", body["body"])

		w.WriteHeader(201)
		json.NewEncoder(w).Encode(githubComment{ID: 1})
	}))
	defer srv.Close()

	tracker := newTestGitHubIssueTracker(srv)
	err := tracker.AddComment(context.Background(), "5", "Nice work!")
	require.NoError(t, err)
}

func TestGitHubIssueTracker_APIError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(404)
		w.Write([]byte(`{"message":"Not Found"}`))
	}))
	defer srv.Close()

	tracker := newTestGitHubIssueTracker(srv)
	_, err := tracker.GetIssue(context.Background(), "999")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "Not Found")
}

// ── SourceControl tests ──────────────────────────────────────────────

func TestGitHubSourceControl_CreateBranch(t *testing.T) {
	callCount := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		callCount++
		switch callCount {
		case 1: // GET ref
			assert.Contains(t, r.URL.Path, "/git/ref/heads/main")
			json.NewEncoder(w).Encode(githubRef{Object: struct {
				SHA string `json:"sha"`
			}{SHA: "abc123"}})
		case 2: // POST refs
			assert.Equal(t, http.MethodPost, r.Method)
			var body map[string]string
			json.NewDecoder(r.Body).Decode(&body)
			assert.Equal(t, "refs/heads/feature-1", body["ref"])
			assert.Equal(t, "abc123", body["sha"])

			w.WriteHeader(201)
			json.NewEncoder(w).Encode(githubRef{})
		}
	}))
	defer srv.Close()

	sc := newTestGitHubSourceControl(srv)
	err := sc.CreateBranch(context.Background(), "test-repo", "feature-1", "main")
	require.NoError(t, err)
}

func TestGitHubSourceControl_CreateBranch_AlreadyExists(t *testing.T) {
	callCount := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		callCount++
		switch callCount {
		case 1:
			json.NewEncoder(w).Encode(githubRef{Object: struct {
				SHA string `json:"sha"`
			}{SHA: "abc123"}})
		case 2:
			w.WriteHeader(422)
			w.Write([]byte(`{"message":"Reference already exists"}`))
		}
	}))
	defer srv.Close()

	sc := newTestGitHubSourceControl(srv)
	err := sc.CreateBranch(context.Background(), "test-repo", "existing", "main")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "already exists")
}

func TestGitHubSourceControl_CreatePullRequest(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, http.MethodPost, r.Method)
		assert.Contains(t, r.URL.Path, "/pulls")

		var body map[string]string
		json.NewDecoder(r.Body).Decode(&body)
		assert.Equal(t, "Test PR", body["title"])
		assert.Equal(t, "feature", body["head"])
		assert.Equal(t, "main", body["base"])

		w.WriteHeader(201)
		json.NewEncoder(w).Encode(githubPull{
			Number: 7, Title: "Test PR", State: "open",
			Head: struct{ Ref string `json:"ref"` }{Ref: "feature"},
			Base: struct{ Ref string `json:"ref"` }{Ref: "main"},
		})
	}))
	defer srv.Close()

	sc := newTestGitHubSourceControl(srv)
	pr, err := sc.CreatePullRequest(context.Background(), &PullRequest{
		Title: "Test PR", SourceBranch: "feature", TargetBranch: "main",
	})
	require.NoError(t, err)
	assert.Equal(t, "7", pr.ID)
	assert.Equal(t, "open", pr.Status)
}

func TestGitHubSourceControl_GetPullRequest(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Contains(t, r.URL.Path, "/pulls/7")
		json.NewEncoder(w).Encode(githubPull{
			Number: 7, Title: "My PR", State: "open", Merged: false,
			Head:    struct{ Ref string `json:"ref"` }{Ref: "feat"},
			Base:    struct{ Ref string `json:"ref"` }{Ref: "main"},
			HTMLURL: "https://github.com/test/pulls/7",
		})
	}))
	defer srv.Close()

	sc := newTestGitHubSourceControl(srv)
	pr, err := sc.GetPullRequest(context.Background(), "test-repo", "7")
	require.NoError(t, err)
	assert.Equal(t, "7", pr.ID)
	assert.Equal(t, "open", pr.Status)
	assert.Equal(t, "feat", pr.SourceBranch)
}

func TestGitHubSourceControl_GetPullRequest_Merged(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(githubPull{
			Number: 8, State: "closed", Merged: true,
			Head: struct{ Ref string `json:"ref"` }{Ref: "feat"},
			Base: struct{ Ref string `json:"ref"` }{Ref: "main"},
		})
	}))
	defer srv.Close()

	sc := newTestGitHubSourceControl(srv)
	pr, err := sc.GetPullRequest(context.Background(), "test-repo", "8")
	require.NoError(t, err)
	assert.Equal(t, "merged", pr.Status)
}

func TestGitHubSourceControl_MergePullRequest(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, http.MethodPut, r.Method)
		assert.Contains(t, r.URL.Path, "/pulls/7/merge")
		w.WriteHeader(200)
		w.Write([]byte(`{"merged":true}`))
	}))
	defer srv.Close()

	sc := newTestGitHubSourceControl(srv)
	err := sc.MergePullRequest(context.Background(), "test-repo", "7")
	require.NoError(t, err)
}

func TestGitHubSourceControl_GetFileContent(t *testing.T) {
	content := base64.StdEncoding.EncodeToString([]byte("hello world"))
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Contains(t, r.URL.Path, "/contents/README.md")
		assert.Equal(t, "main", r.URL.Query().Get("ref"))
		json.NewEncoder(w).Encode(githubContent{Content: content, Encoding: "base64"})
	}))
	defer srv.Close()

	sc := newTestGitHubSourceControl(srv)
	data, err := sc.GetFileContent(context.Background(), "test-repo", "README.md", "main")
	require.NoError(t, err)
	assert.Equal(t, "hello world", string(data))
}

// ── CIPipeline tests ────────────────────────────────────────────────

func TestGitHubCIPipeline_GetPipelineStatus(t *testing.T) {
	tests := []struct {
		name       string
		status     string
		conclusion string
		expected   string
	}{
		{"queued", "queued", "", "pending"},
		{"in_progress", "in_progress", "", "running"},
		{"success", "completed", "success", "succeeded"},
		{"failure", "completed", "failure", "failed"},
		{"cancelled", "completed", "cancelled", "cancelled"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				assert.Contains(t, r.URL.Path, "/actions/runs/100")
				json.NewEncoder(w).Encode(githubWorkflowRun{
					ID: 100, Status: tt.status, Conclusion: tt.conclusion,
					HTMLURL: "https://github.com/test/actions/runs/100",
				})
			}))
			defer srv.Close()

			ci := newTestGitHubCIPipeline(srv)
			run, err := ci.GetPipelineStatus(context.Background(), "test-repo", "100")
			require.NoError(t, err)
			assert.Equal(t, "100", run.ID)
			assert.Equal(t, tt.expected, run.Status)
		})
	}
}

func TestGitHubCIPipeline_CancelPipeline(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, http.MethodPost, r.Method)
		assert.Contains(t, r.URL.Path, "/actions/runs/100/cancel")
		w.WriteHeader(202)
	}))
	defer srv.Close()

	ci := newTestGitHubCIPipeline(srv)
	err := ci.CancelPipeline(context.Background(), "test-repo", "100")
	require.NoError(t, err)
}

func TestGitHubCIPipeline_CancelPipeline_Error(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(409)
		w.Write([]byte(`{"message":"Cannot cancel"}`))
	}))
	defer srv.Close()

	ci := newTestGitHubCIPipeline(srv)
	err := ci.CancelPipeline(context.Background(), "test-repo", "100")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "Cannot cancel")
}
