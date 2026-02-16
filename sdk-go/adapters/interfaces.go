// Package adapters provides adapter interfaces, registry, and implementations.
package adapters

import "context"

// Issue represents an issue from an issue tracker.
type Issue struct {
	ID          string            `json:"id"`
	Title       string            `json:"title"`
	Description string            `json:"description,omitempty"`
	Status      string            `json:"status"`
	Assignee    string            `json:"assignee,omitempty"`
	Labels      []string          `json:"labels,omitempty"`
	URL         string            `json:"url,omitempty"`
	Metadata    map[string]string `json:"metadata,omitempty"`
}

// IssueTracker manages issues.
type IssueTracker interface {
	GetIssue(ctx context.Context, id string) (*Issue, error)
	CreateIssue(ctx context.Context, issue *Issue) (*Issue, error)
	UpdateIssue(ctx context.Context, id string, updates map[string]interface{}) (*Issue, error)
	AddComment(ctx context.Context, issueID, comment string) error
	ListIssues(ctx context.Context, filter map[string]string) ([]*Issue, error)
}

// PullRequest represents a pull/merge request.
type PullRequest struct {
	ID          string   `json:"id"`
	Title       string   `json:"title"`
	Description string   `json:"description,omitempty"`
	SourceBranch string  `json:"sourceBranch"`
	TargetBranch string  `json:"targetBranch"`
	Status      string   `json:"status"`
	URL         string   `json:"url,omitempty"`
}

// SourceControl manages source code repositories.
type SourceControl interface {
	CreateBranch(ctx context.Context, repo, branchName, fromRef string) error
	CreatePullRequest(ctx context.Context, pr *PullRequest) (*PullRequest, error)
	GetPullRequest(ctx context.Context, repo, id string) (*PullRequest, error)
	MergePullRequest(ctx context.Context, repo, id string) error
	GetFileContent(ctx context.Context, repo, path, ref string) ([]byte, error)
}

// PipelineRun represents a CI pipeline execution.
type PipelineRun struct {
	ID     string `json:"id"`
	Status string `json:"status"`
	URL    string `json:"url,omitempty"`
}

// CIPipeline manages CI/CD pipelines.
type CIPipeline interface {
	TriggerPipeline(ctx context.Context, repo, ref string, params map[string]string) (*PipelineRun, error)
	GetPipelineStatus(ctx context.Context, repo, runID string) (*PipelineRun, error)
	CancelPipeline(ctx context.Context, repo, runID string) error
}

// AnalysisFinding represents a code analysis finding.
type AnalysisFinding struct {
	RuleID   string `json:"ruleId"`
	Severity string `json:"severity"`
	Message  string `json:"message"`
	File     string `json:"file"`
	Line     int    `json:"line"`
}

// AnalysisResult is the result of a code analysis run.
type AnalysisResult struct {
	Tool     string            `json:"tool"`
	Passed   bool              `json:"passed"`
	Findings []AnalysisFinding `json:"findings"`
}

// CodeAnalysis runs static analysis on code.
type CodeAnalysis interface {
	Analyze(ctx context.Context, repo, ref string, rulesets []string) (*AnalysisResult, error)
}

// Message represents a notification message.
type Message struct {
	Target  string `json:"target"`
	Title   string `json:"title"`
	Body    string `json:"body"`
	Channel string `json:"channel,omitempty"`
}

// Messenger sends notifications.
type Messenger interface {
	Send(ctx context.Context, msg *Message) error
}

// Deployment represents a deployment.
type Deployment struct {
	ID          string `json:"id"`
	Environment string `json:"environment"`
	Status      string `json:"status"`
	URL         string `json:"url,omitempty"`
}

// DeploymentTarget manages deployments.
type DeploymentTarget interface {
	Deploy(ctx context.Context, environment, artifact string, config map[string]string) (*Deployment, error)
	GetDeploymentStatus(ctx context.Context, deploymentID string) (*Deployment, error)
	Rollback(ctx context.Context, deploymentID string) error
}

// Event represents an event in the event bus.
type Event struct {
	Type    string                 `json:"type"`
	Source  string                 `json:"source"`
	Data    map[string]interface{} `json:"data"`
}

// EventHandler processes events.
type EventHandler func(ctx context.Context, event *Event) error

// EventBus provides publish/subscribe messaging.
type EventBus interface {
	Publish(ctx context.Context, event *Event) error
	Subscribe(eventType string, handler EventHandler) (func(), error)
}
