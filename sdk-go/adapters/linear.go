package adapters

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
)

const defaultLinearBaseURL = "https://api.linear.app"

// ── GraphQL queries and mutations ────────────────────────────────────

const linearListIssuesQuery = `query($teamId: String!, $filter: IssueFilter) {
  issues(filter: { team: { id: { eq: $teamId } }, and: [$filter] }, first: 100) {
    nodes {
      id
      identifier
      title
      description
      state { name }
      assignee { name }
      labels { nodes { name } }
      url
    }
  }
}`

const linearGetIssueQuery = `query($id: String!) {
  issue(id: $id) {
    id
    identifier
    title
    description
    state { name }
    assignee { name }
    labels { nodes { name } }
    url
  }
}`

const linearCreateIssueMutation = `mutation($teamId: String!, $title: String!, $description: String) {
  issueCreate(input: { teamId: $teamId, title: $title, description: $description }) {
    success
    issue {
      id
      identifier
      title
      description
      state { name }
      assignee { name }
      labels { nodes { name } }
      url
    }
  }
}`

const linearUpdateIssueMutation = `mutation($id: String!, $title: String, $description: String, $stateId: String, $assigneeId: String) {
  issueUpdate(id: $id, input: { title: $title, description: $description, stateId: $stateId, assigneeId: $assigneeId }) {
    success
    issue {
      id
      identifier
      title
      description
      state { name }
      assignee { name }
      labels { nodes { name } }
      url
    }
  }
}`

const linearCreateCommentMutation = `mutation($issueId: String!, $body: String!) {
  commentCreate(input: { issueId: $issueId, body: $body }) {
    success
  }
}`

// ── LinearIssueTracker ───────────────────────────────────────────────

// LinearIssueTracker implements IssueTracker using the Linear GraphQL API.
type LinearIssueTracker struct {
	APIKey  string
	TeamID  string
	BaseURL string
	Client  HTTPClient
}

// NewLinearIssueTracker creates a new Linear issue tracker.
func NewLinearIssueTracker(apiKey, teamID string) *LinearIssueTracker {
	return &LinearIssueTracker{
		APIKey:  apiKey,
		TeamID:  teamID,
		BaseURL: defaultLinearBaseURL,
		Client:  http.DefaultClient,
	}
}

type graphqlRequest struct {
	Query     string                 `json:"query"`
	Variables map[string]interface{} `json:"variables,omitempty"`
}

type graphqlResponse struct {
	Data   json.RawMessage `json:"data"`
	Errors []struct {
		Message string `json:"message"`
	} `json:"errors"`
}

func (l *LinearIssueTracker) graphql(ctx context.Context, query string, variables map[string]interface{}) (map[string]interface{}, error) {
	url := l.BaseURL + "/graphql"
	reqBody := graphqlRequest{Query: query, Variables: variables}
	headers := map[string]string{
		"Authorization": l.APIKey,
		"Content-Type":  "application/json",
	}

	resp, err := doJSON[graphqlResponse](ctx, l.Client, http.MethodPost, url, reqBody, headers)
	if err != nil {
		return nil, err
	}

	if len(resp.Errors) > 0 {
		return nil, fmt.Errorf("graphql error: %s", resp.Errors[0].Message)
	}

	var data map[string]interface{}
	if err := json.Unmarshal(resp.Data, &data); err != nil {
		return nil, fmt.Errorf("decode graphql data: %w", err)
	}
	return data, nil
}

func mapLinearNode(node map[string]interface{}) *Issue {
	issue := &Issue{}

	if v, ok := node["id"].(string); ok {
		issue.ID = v
	}
	if v, ok := node["identifier"].(string); ok {
		issue.ID = v // prefer identifier (e.g. "ENG-123")
	}
	if v, ok := node["title"].(string); ok {
		issue.Title = v
	}
	if v, ok := node["description"].(string); ok {
		issue.Description = v
	}
	if v, ok := node["url"].(string); ok {
		issue.URL = v
	}
	if state, ok := node["state"].(map[string]interface{}); ok {
		if name, ok := state["name"].(string); ok {
			issue.Status = name
		}
	}
	if assignee, ok := node["assignee"].(map[string]interface{}); ok {
		if name, ok := assignee["name"].(string); ok {
			issue.Assignee = name
		}
	}
	if labels, ok := node["labels"].(map[string]interface{}); ok {
		if nodes, ok := labels["nodes"].([]interface{}); ok {
			for _, n := range nodes {
				if lbl, ok := n.(map[string]interface{}); ok {
					if name, ok := lbl["name"].(string); ok {
						issue.Labels = append(issue.Labels, name)
					}
				}
			}
		}
	}
	return issue
}

func (l *LinearIssueTracker) ListIssues(ctx context.Context, filter map[string]string) ([]*Issue, error) {
	variables := map[string]interface{}{
		"teamId": l.TeamID,
	}

	data, err := l.graphql(ctx, linearListIssuesQuery, variables)
	if err != nil {
		return nil, fmt.Errorf("list issues: %w", err)
	}

	issuesData, ok := data["issues"].(map[string]interface{})
	if !ok {
		return nil, nil
	}
	nodes, ok := issuesData["nodes"].([]interface{})
	if !ok {
		return nil, nil
	}

	var issues []*Issue
	for _, n := range nodes {
		if node, ok := n.(map[string]interface{}); ok {
			issues = append(issues, mapLinearNode(node))
		}
	}
	return issues, nil
}

func (l *LinearIssueTracker) GetIssue(ctx context.Context, id string) (*Issue, error) {
	variables := map[string]interface{}{"id": id}

	data, err := l.graphql(ctx, linearGetIssueQuery, variables)
	if err != nil {
		return nil, fmt.Errorf("get issue %s: %w", id, err)
	}

	issueData, ok := data["issue"].(map[string]interface{})
	if !ok {
		return nil, fmt.Errorf("issue %s not found", id)
	}
	return mapLinearNode(issueData), nil
}

func (l *LinearIssueTracker) CreateIssue(ctx context.Context, issue *Issue) (*Issue, error) {
	variables := map[string]interface{}{
		"teamId":      l.TeamID,
		"title":       issue.Title,
		"description": issue.Description,
	}

	data, err := l.graphql(ctx, linearCreateIssueMutation, variables)
	if err != nil {
		return nil, fmt.Errorf("create issue: %w", err)
	}

	create, ok := data["issueCreate"].(map[string]interface{})
	if !ok {
		return nil, fmt.Errorf("unexpected response from issueCreate")
	}
	issueData, ok := create["issue"].(map[string]interface{})
	if !ok {
		return nil, fmt.Errorf("no issue in issueCreate response")
	}
	return mapLinearNode(issueData), nil
}

func (l *LinearIssueTracker) UpdateIssue(ctx context.Context, id string, updates map[string]interface{}) (*Issue, error) {
	variables := map[string]interface{}{"id": id}
	for k, v := range updates {
		variables[k] = v
	}

	data, err := l.graphql(ctx, linearUpdateIssueMutation, variables)
	if err != nil {
		return nil, fmt.Errorf("update issue %s: %w", id, err)
	}

	update, ok := data["issueUpdate"].(map[string]interface{})
	if !ok {
		return nil, fmt.Errorf("unexpected response from issueUpdate")
	}
	issueData, ok := update["issue"].(map[string]interface{})
	if !ok {
		return nil, fmt.Errorf("no issue in issueUpdate response")
	}
	return mapLinearNode(issueData), nil
}

func (l *LinearIssueTracker) AddComment(ctx context.Context, issueID, comment string) error {
	variables := map[string]interface{}{
		"issueId": issueID,
		"body":    comment,
	}

	data, err := l.graphql(ctx, linearCreateCommentMutation, variables)
	if err != nil {
		return fmt.Errorf("add comment to %s: %w", issueID, err)
	}

	create, ok := data["commentCreate"].(map[string]interface{})
	if !ok {
		return fmt.Errorf("unexpected response from commentCreate")
	}
	if success, ok := create["success"].(bool); !ok || !success {
		return fmt.Errorf("commentCreate returned success=false")
	}
	return nil
}
