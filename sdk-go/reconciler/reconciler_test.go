package reconciler

import (
	"context"
	"testing"
	"time"

	"github.com/ai-sdlc-framework/ai-sdlc/sdk-go/core"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestResourceFingerprint(t *testing.T) {
	p := &core.Pipeline{
		APIVersion: core.APIVersion,
		Kind:       "Pipeline",
		Metadata:   core.Metadata{Name: "test"},
		Spec: core.PipelineSpec{
			Triggers:  []core.Trigger{{Event: "push"}},
			Providers: map[string]core.Provider{"ci": {Type: "github"}},
			Stages:    []core.Stage{{Name: "build"}},
		},
	}

	fp1, err := ResourceFingerprint(p)
	require.NoError(t, err)
	assert.NotEmpty(t, fp1)

	fp2, err := ResourceFingerprint(p)
	require.NoError(t, err)
	assert.Equal(t, fp1, fp2, "same resource should produce same fingerprint")
}

func TestResourceCacheDetectsChange(t *testing.T) {
	cache := NewResourceCache()
	p := &core.Pipeline{
		APIVersion: core.APIVersion,
		Kind:       "Pipeline",
		Metadata:   core.Metadata{Name: "test"},
		Spec: core.PipelineSpec{
			Triggers:  []core.Trigger{{Event: "push"}},
			Providers: map[string]core.Provider{"ci": {Type: "github"}},
			Stages:    []core.Stage{{Name: "build"}},
		},
	}

	changed, err := cache.HasSpecChanged(p)
	require.NoError(t, err)
	assert.True(t, changed, "first check should be changed")

	changed, err = cache.HasSpecChanged(p)
	require.NoError(t, err)
	assert.False(t, changed, "second check should not be changed")

	p.Spec.Stages = append(p.Spec.Stages, core.Stage{Name: "test"})
	changed, err = cache.HasSpecChanged(p)
	require.NoError(t, err)
	assert.True(t, changed, "modified resource should be changed")
}

func TestPipelineReconciler(t *testing.T) {
	var updateCount int
	p := &core.Pipeline{
		APIVersion: core.APIVersion,
		Kind:       "Pipeline",
		Metadata:   core.Metadata{Name: "test"},
		Spec: core.PipelineSpec{
			Triggers:  []core.Trigger{{Event: "push"}},
			Providers: map[string]core.Provider{},
			Stages:    []core.Stage{{Name: "build"}},
		},
	}

	fn := CreatePipelineReconciler(p, func(ctx context.Context, p *core.Pipeline) error {
		updateCount++
		return nil
	})

	ctx := context.Background()
	result, err := fn(ctx)
	require.NoError(t, err)
	assert.Equal(t, 1, updateCount)

	result, err = fn(ctx)
	require.NoError(t, err)
	assert.False(t, result.Requeue)
	assert.Equal(t, 1, updateCount, "should not update when unchanged")
}

func TestReconcilerLoop(t *testing.T) {
	var count int
	fn := func(ctx context.Context) (*ReconcileResult, error) {
		count++
		return &ReconcileResult{Requeue: false}, nil
	}

	loop := NewReconcilerLoop(fn, &ReconcilerConfig{
		Interval:     50 * time.Millisecond,
		MaxRetries:   1,
		RetryBackoff: 10 * time.Millisecond,
	})

	ctx := context.Background()
	loop.Start(ctx)
	assert.True(t, loop.IsRunning())

	time.Sleep(180 * time.Millisecond)
	loop.Stop()

	assert.GreaterOrEqual(t, count, 2)
}
