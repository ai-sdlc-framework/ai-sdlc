package security

import (
	"context"
	"time"

	"github.com/ai-sdlc-framework/ai-sdlc/sdk-go/internal/duration"
)

// SecretsClient is the interface for GitHub Secrets operations.
type SecretsClient interface {
	SetSecret(ctx context.Context, repo, name, value string) error
	DeleteSecret(ctx context.Context, repo, name string) error
}

// GitHubJITCredentialIssuer uses GitHub Secrets for JIT credentials.
type GitHubJITCredentialIssuer struct {
	client SecretsClient
	repo   string
}

// NewGitHubJITCredentialIssuer creates a JIT credential issuer backed by GitHub Secrets.
func NewGitHubJITCredentialIssuer(client SecretsClient, repo string) *GitHubJITCredentialIssuer {
	return &GitHubJITCredentialIssuer{client: client, repo: repo}
}

func (g *GitHubJITCredentialIssuer) Issue(ctx context.Context, scope []string, ttl string) (*JITCredential, error) {
	dur, err := duration.ParseDuration(ttl)
	if err != nil {
		dur = 10 * time.Minute
	}

	name := "JIT_CRED_" + scope[0]
	value := "jit-" + time.Now().UTC().Format("20060102T150405Z")
	expiresAt := time.Now().UTC().Add(dur).Format(time.RFC3339)

	if err := g.client.SetSecret(ctx, g.repo, name, value); err != nil {
		return nil, err
	}

	return &JITCredential{Name: name, Value: value, ExpiresAt: expiresAt}, nil
}

func (g *GitHubJITCredentialIssuer) Revoke(ctx context.Context, cred *JITCredential) error {
	return g.client.DeleteSecret(ctx, g.repo, cred.Name)
}
