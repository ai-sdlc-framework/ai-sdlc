package security

import (
	"context"
	"fmt"
	"sync"
)

// StubSandbox is a no-op sandbox for testing.
type StubSandbox struct{}

func NewStubSandbox() *StubSandbox { return &StubSandbox{} }

func (s *StubSandbox) Execute(ctx context.Context, command string, args []string) (*SandboxResult, error) {
	return &SandboxResult{ExitCode: 0, Stdout: "stub", Stderr: ""}, nil
}
func (s *StubSandbox) Cleanup(ctx context.Context) error { return nil }

// StubSecretStore is an in-memory secret store for testing.
type StubSecretStore struct {
	mu      sync.RWMutex
	secrets map[string]string
}

func NewStubSecretStore() *StubSecretStore {
	return &StubSecretStore{secrets: make(map[string]string)}
}

func (s *StubSecretStore) GetSecret(ctx context.Context, name string) (string, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	v, ok := s.secrets[name]
	if !ok {
		return "", fmt.Errorf("secret not found: %s", name)
	}
	return v, nil
}

func (s *StubSecretStore) SetSecret(ctx context.Context, name, value string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.secrets[name] = value
	return nil
}

func (s *StubSecretStore) DeleteSecret(ctx context.Context, name string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.secrets, name)
	return nil
}

func (s *StubSecretStore) ListSecrets(ctx context.Context) ([]string, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	keys := make([]string, 0, len(s.secrets))
	for k := range s.secrets {
		keys = append(keys, k)
	}
	return keys, nil
}

// StubJITCredentialIssuer returns stub credentials for testing.
type StubJITCredentialIssuer struct{}

func NewStubJITCredentialIssuer() *StubJITCredentialIssuer { return &StubJITCredentialIssuer{} }

func (s *StubJITCredentialIssuer) Issue(ctx context.Context, scope []string, ttl string) (*JITCredential, error) {
	return &JITCredential{Name: "stub-cred", Value: "stub-value", ExpiresAt: "2099-12-31T23:59:59Z"}, nil
}
func (s *StubJITCredentialIssuer) Revoke(ctx context.Context, cred *JITCredential) error { return nil }

// StubKillSwitch is a no-op kill switch for testing.
type StubKillSwitch struct {
	mu     sync.Mutex
	active bool
}

func NewStubKillSwitch() *StubKillSwitch { return &StubKillSwitch{} }

func (s *StubKillSwitch) Activate(ctx context.Context, reason string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.active = true
	return nil
}

func (s *StubKillSwitch) Deactivate(ctx context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.active = false
	return nil
}

func (s *StubKillSwitch) IsActive(ctx context.Context) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.active, nil
}

// StubApprovalWorkflow is an auto-approving workflow for testing.
type StubApprovalWorkflow struct {
	mu       sync.Mutex
	requests map[string]*ApprovalRequest
	responses map[string]*ApprovalResponse
}

func NewStubApprovalWorkflow() *StubApprovalWorkflow {
	return &StubApprovalWorkflow{
		requests:  make(map[string]*ApprovalRequest),
		responses: make(map[string]*ApprovalResponse),
	}
}

func (s *StubApprovalWorkflow) Request(ctx context.Context, req *ApprovalRequest) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.requests[req.ID] = req
	return nil
}

func (s *StubApprovalWorkflow) Respond(ctx context.Context, resp *ApprovalResponse) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.responses[resp.RequestID] = resp
	return nil
}

func (s *StubApprovalWorkflow) GetStatus(ctx context.Context, requestID string) (*ApprovalRequest, *ApprovalResponse, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.requests[requestID], s.responses[requestID], nil
}
