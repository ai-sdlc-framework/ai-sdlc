// Package security provides sandbox, secret management, JIT credentials, kill switch, and approval workflows.
package security

import "context"

// SandboxResult is the outcome of running a command in a sandbox.
type SandboxResult struct {
	ExitCode int    `json:"exitCode"`
	Stdout   string `json:"stdout"`
	Stderr   string `json:"stderr"`
}

// Sandbox defines an isolated execution environment.
type Sandbox interface {
	Execute(ctx context.Context, command string, args []string) (*SandboxResult, error)
	Cleanup(ctx context.Context) error
}

// SecretStore provides access to secrets.
type SecretStore interface {
	GetSecret(ctx context.Context, name string) (string, error)
	SetSecret(ctx context.Context, name, value string) error
	DeleteSecret(ctx context.Context, name string) error
	ListSecrets(ctx context.Context) ([]string, error)
}

// JITCredential represents a just-in-time credential.
type JITCredential struct {
	Name      string `json:"name"`
	Value     string `json:"value"`
	ExpiresAt string `json:"expiresAt"`
}

// JITCredentialIssuer issues and revokes short-lived credentials.
type JITCredentialIssuer interface {
	Issue(ctx context.Context, scope []string, ttl string) (*JITCredential, error)
	Revoke(ctx context.Context, credential *JITCredential) error
}

// KillSwitch provides emergency stop capability.
type KillSwitch interface {
	Activate(ctx context.Context, reason string) error
	Deactivate(ctx context.Context) error
	IsActive(ctx context.Context) (bool, error)
}

// ApprovalTier represents the required approval level.
type ApprovalTier string

const (
	TierAuto           ApprovalTier = "auto"
	TierPeerReview     ApprovalTier = "peer-review"
	TierTeamLead       ApprovalTier = "team-lead"
	TierSecurityReview ApprovalTier = "security-review"
)

// ApprovalRequest represents a request for approval.
type ApprovalRequest struct {
	ID           string       `json:"id"`
	Stage        string       `json:"stage"`
	Tier         ApprovalTier `json:"tier"`
	Requester    string       `json:"requester"`
	Description  string       `json:"description"`
	RequestedAt  string       `json:"requestedAt"`
}

// ApprovalResponse represents the response to an approval request.
type ApprovalResponse struct {
	RequestID string `json:"requestId"`
	Approved  bool   `json:"approved"`
	Approver  string `json:"approver"`
	Comment   string `json:"comment,omitempty"`
	Timestamp string `json:"timestamp"`
}

// ApprovalWorkflow manages approval requests.
type ApprovalWorkflow interface {
	Request(ctx context.Context, req *ApprovalRequest) error
	Respond(ctx context.Context, resp *ApprovalResponse) error
	GetStatus(ctx context.Context, requestID string) (*ApprovalRequest, *ApprovalResponse, error)
}
