package adapters

import (
	"context"
	"fmt"
)

// LinearIssueTracker is a stub Linear issue tracker.
type LinearIssueTracker struct {
	APIKey string
	TeamID string
}

func NewLinearIssueTracker(apiKey, teamID string) *LinearIssueTracker {
	return &LinearIssueTracker{APIKey: apiKey, TeamID: teamID}
}

func (l *LinearIssueTracker) GetIssue(ctx context.Context, id string) (*Issue, error) {
	return nil, fmt.Errorf("LinearIssueTracker.GetIssue: not implemented")
}
func (l *LinearIssueTracker) CreateIssue(ctx context.Context, issue *Issue) (*Issue, error) {
	return nil, fmt.Errorf("LinearIssueTracker.CreateIssue: not implemented")
}
func (l *LinearIssueTracker) UpdateIssue(ctx context.Context, id string, updates map[string]interface{}) (*Issue, error) {
	return nil, fmt.Errorf("LinearIssueTracker.UpdateIssue: not implemented")
}
func (l *LinearIssueTracker) AddComment(ctx context.Context, issueID, comment string) error {
	return fmt.Errorf("LinearIssueTracker.AddComment: not implemented")
}
func (l *LinearIssueTracker) ListIssues(ctx context.Context, filter map[string]string) ([]*Issue, error) {
	return nil, fmt.Errorf("LinearIssueTracker.ListIssues: not implemented")
}
