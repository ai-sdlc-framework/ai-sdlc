package security

import (
	"context"
	"os"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestClassifyApprovalTier(t *testing.T) {
	assert.Equal(t, TierSecurityReview, ClassifyApprovalTier(true, false, 10))
	assert.Equal(t, TierTeamLead, ClassifyApprovalTier(false, true, 10))
	assert.Equal(t, TierTeamLead, ClassifyApprovalTier(false, false, 600))
	assert.Equal(t, TierPeerReview, ClassifyApprovalTier(false, false, 200))
	assert.Equal(t, TierAuto, ClassifyApprovalTier(false, false, 50))
}

func TestCompareTiers(t *testing.T) {
	assert.True(t, CompareTiers(TierAuto, TierPeerReview) < 0)
	assert.True(t, CompareTiers(TierSecurityReview, TierPeerReview) > 0)
	assert.Equal(t, 0, CompareTiers(TierTeamLead, TierTeamLead))
}

func TestStubSandbox(t *testing.T) {
	ctx := context.Background()
	s := NewStubSandbox()

	result, err := s.Execute(ctx, "echo", []string{"hello"})
	require.NoError(t, err)
	assert.Equal(t, 0, result.ExitCode)
	assert.NoError(t, s.Cleanup(ctx))
}

func TestStubSecretStore(t *testing.T) {
	ctx := context.Background()
	store := NewStubSecretStore()

	err := store.SetSecret(ctx, "api-key", "secret123")
	require.NoError(t, err)

	val, err := store.GetSecret(ctx, "api-key")
	require.NoError(t, err)
	assert.Equal(t, "secret123", val)

	_, err = store.GetSecret(ctx, "missing")
	assert.Error(t, err)

	keys, err := store.ListSecrets(ctx)
	require.NoError(t, err)
	assert.Contains(t, keys, "api-key")

	err = store.DeleteSecret(ctx, "api-key")
	require.NoError(t, err)
}

func TestStubKillSwitch(t *testing.T) {
	ctx := context.Background()
	ks := NewStubKillSwitch()

	active, _ := ks.IsActive(ctx)
	assert.False(t, active)

	ks.Activate(ctx, "emergency")
	active, _ = ks.IsActive(ctx)
	assert.True(t, active)

	ks.Deactivate(ctx)
	active, _ = ks.IsActive(ctx)
	assert.False(t, active)
}

func TestEnvSecretStore(t *testing.T) {
	ctx := context.Background()
	os.Setenv("TEST_MY_SECRET", "value123")
	defer os.Unsetenv("TEST_MY_SECRET")

	store := NewEnvSecretStore("TEST")
	val, err := store.GetSecret(ctx, "my-secret")
	require.NoError(t, err)
	assert.Equal(t, "value123", val)
}
