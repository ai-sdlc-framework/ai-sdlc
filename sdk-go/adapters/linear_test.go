package adapters

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func newTestLinearTracker(srv *httptest.Server) *LinearIssueTracker {
	return &LinearIssueTracker{
		APIKey:  "lin_test_key",
		TeamID:  "team-1",
		BaseURL: srv.URL,
		Client:  srv.Client(),
	}
}

func linearResponse(data interface{}) []byte {
	resp := map[string]interface{}{"data": data}
	b, _ := json.Marshal(resp)
	return b
}

func TestLinearIssueTracker_ListIssues(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, http.MethodPost, r.Method)
		assert.Equal(t, "lin_test_key", r.Header.Get("Authorization"))

		w.Write(linearResponse(map[string]interface{}{
			"issues": map[string]interface{}{
				"nodes": []interface{}{
					map[string]interface{}{
						"id":         "uuid-1",
						"identifier": "ENG-1",
						"title":      "First Issue",
						"state":      map[string]interface{}{"name": "In Progress"},
						"assignee":   map[string]interface{}{"name": "Alice"},
						"labels":     map[string]interface{}{"nodes": []interface{}{map[string]interface{}{"name": "bug"}}},
					},
					map[string]interface{}{
						"id":         "uuid-2",
						"identifier": "ENG-2",
						"title":      "Second Issue",
						"state":      map[string]interface{}{"name": "Todo"},
					},
				},
			},
		}))
	}))
	defer srv.Close()

	tracker := newTestLinearTracker(srv)
	issues, err := tracker.ListIssues(context.Background(), nil)
	require.NoError(t, err)
	assert.Len(t, issues, 2)
	assert.Equal(t, "ENG-1", issues[0].ID)
	assert.Equal(t, "First Issue", issues[0].Title)
	assert.Equal(t, "In Progress", issues[0].Status)
	assert.Equal(t, "Alice", issues[0].Assignee)
	assert.Equal(t, []string{"bug"}, issues[0].Labels)
	assert.Equal(t, "ENG-2", issues[1].ID)
}

func TestLinearIssueTracker_GetIssue(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req graphqlRequest
		json.NewDecoder(r.Body).Decode(&req)
		assert.Equal(t, "issue-id", req.Variables["id"])

		w.Write(linearResponse(map[string]interface{}{
			"issue": map[string]interface{}{
				"id":          "uuid-1",
				"identifier":  "ENG-42",
				"title":       "Test Issue",
				"description": "Details here",
				"state":       map[string]interface{}{"name": "Done"},
				"url":         "https://linear.app/team/ENG-42",
			},
		}))
	}))
	defer srv.Close()

	tracker := newTestLinearTracker(srv)
	issue, err := tracker.GetIssue(context.Background(), "issue-id")
	require.NoError(t, err)
	assert.Equal(t, "ENG-42", issue.ID)
	assert.Equal(t, "Test Issue", issue.Title)
	assert.Equal(t, "Details here", issue.Description)
	assert.Equal(t, "Done", issue.Status)
}

func TestLinearIssueTracker_CreateIssue(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req graphqlRequest
		json.NewDecoder(r.Body).Decode(&req)
		assert.Equal(t, "team-1", req.Variables["teamId"])
		assert.Equal(t, "New Feature", req.Variables["title"])

		w.Write(linearResponse(map[string]interface{}{
			"issueCreate": map[string]interface{}{
				"success": true,
				"issue": map[string]interface{}{
					"id":         "uuid-new",
					"identifier": "ENG-99",
					"title":      "New Feature",
					"state":      map[string]interface{}{"name": "Todo"},
				},
			},
		}))
	}))
	defer srv.Close()

	tracker := newTestLinearTracker(srv)
	issue, err := tracker.CreateIssue(context.Background(), &Issue{
		Title:       "New Feature",
		Description: "Build the thing",
	})
	require.NoError(t, err)
	assert.Equal(t, "ENG-99", issue.ID)
	assert.Equal(t, "New Feature", issue.Title)
}

func TestLinearIssueTracker_UpdateIssue(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req graphqlRequest
		json.NewDecoder(r.Body).Decode(&req)
		assert.Equal(t, "issue-id", req.Variables["id"])
		assert.Equal(t, "Updated Title", req.Variables["title"])

		w.Write(linearResponse(map[string]interface{}{
			"issueUpdate": map[string]interface{}{
				"success": true,
				"issue": map[string]interface{}{
					"id":         "uuid-1",
					"identifier": "ENG-42",
					"title":      "Updated Title",
					"state":      map[string]interface{}{"name": "In Progress"},
				},
			},
		}))
	}))
	defer srv.Close()

	tracker := newTestLinearTracker(srv)
	issue, err := tracker.UpdateIssue(context.Background(), "issue-id", map[string]interface{}{
		"title": "Updated Title",
	})
	require.NoError(t, err)
	assert.Equal(t, "Updated Title", issue.Title)
}

func TestLinearIssueTracker_AddComment(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req graphqlRequest
		json.NewDecoder(r.Body).Decode(&req)
		assert.Equal(t, "issue-id", req.Variables["issueId"])
		assert.Equal(t, "Great job!", req.Variables["body"])

		w.Write(linearResponse(map[string]interface{}{
			"commentCreate": map[string]interface{}{
				"success": true,
			},
		}))
	}))
	defer srv.Close()

	tracker := newTestLinearTracker(srv)
	err := tracker.AddComment(context.Background(), "issue-id", "Great job!")
	require.NoError(t, err)
}

func TestLinearIssueTracker_GraphQLError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		resp := map[string]interface{}{
			"data":   nil,
			"errors": []interface{}{map[string]interface{}{"message": "Entity not found"}},
		}
		json.NewEncoder(w).Encode(resp)
	}))
	defer srv.Close()

	tracker := newTestLinearTracker(srv)
	_, err := tracker.GetIssue(context.Background(), "bad-id")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "Entity not found")
}

func TestLinearIssueTracker_HTTPError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(401)
		w.Write([]byte(`{"message":"Unauthorized"}`))
	}))
	defer srv.Close()

	tracker := newTestLinearTracker(srv)
	_, err := tracker.ListIssues(context.Background(), nil)
	require.Error(t, err)
}
