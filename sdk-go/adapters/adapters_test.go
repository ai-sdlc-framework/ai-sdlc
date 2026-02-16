package adapters

import (
	"context"
	"sync/atomic"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestAdapterRegistry(t *testing.T) {
	reg := NewAdapterRegistry()

	err := reg.Register(AdapterMetadata{
		Name:      "linear",
		Interface: "IssueTracker",
		Version:   "1.0.0",
	}, func(config map[string]interface{}) (interface{}, error) {
		return "linear-instance", nil
	})
	require.NoError(t, err)

	factory, err := reg.Get("IssueTracker", "linear")
	require.NoError(t, err)
	instance, err := factory(nil)
	require.NoError(t, err)
	assert.Equal(t, "linear-instance", instance)

	list := reg.List()
	assert.Len(t, list, 1)
}

func TestAdapterRegistryNotFound(t *testing.T) {
	reg := NewAdapterRegistry()
	_, err := reg.Get("IssueTracker", "missing")
	assert.Error(t, err)
}

func TestInProcessEventBus(t *testing.T) {
	bus := NewInProcessEventBus()
	ctx := context.Background()

	var count int32
	unsub, err := bus.Subscribe("test.event", func(ctx context.Context, event *Event) error {
		atomic.AddInt32(&count, 1)
		return nil
	})
	require.NoError(t, err)
	defer unsub()

	err = bus.Publish(ctx, &Event{Type: "test.event", Source: "test", Data: nil})
	require.NoError(t, err)
	assert.Equal(t, int32(1), atomic.LoadInt32(&count))
}

func TestParseGitAdapterRef(t *testing.T) {
	ref, err := ParseGitAdapterRef("https://github.com/org/repo@v1.0.0:adapters/linear")
	require.NoError(t, err)
	assert.Equal(t, "https://github.com/org/repo", ref.Repo)
	assert.Equal(t, "v1.0.0", ref.Ref)
	assert.Equal(t, "adapters/linear", ref.Path)
}

func TestParseMetadataYAML(t *testing.T) {
	yaml := `
name: my-adapter
interface: IssueTracker
version: 1.0.0
tags:
  - issue-tracking
`
	meta, err := ParseMetadataYAML([]byte(yaml))
	require.NoError(t, err)
	assert.Equal(t, "my-adapter", meta.Name)
	assert.Equal(t, "IssueTracker", meta.Interface)
}
