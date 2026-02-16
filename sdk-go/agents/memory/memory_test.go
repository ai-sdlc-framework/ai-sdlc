package memory

import (
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestWorkingMemory(t *testing.T) {
	m := NewWorkingMemory()
	m.Set("key", "value")

	val, ok := m.Get("key")
	assert.True(t, ok)
	assert.Equal(t, "value", val)

	m.Delete("key")
	_, ok = m.Get("key")
	assert.False(t, ok)

	m.Set("a", 1)
	m.Clear()
	_, ok = m.Get("a")
	assert.False(t, ok)
}

func TestShortTermMemory(t *testing.T) {
	m := NewShortTermMemory()
	m.Set("key", "value", 100*time.Millisecond)

	val, ok := m.Get("key")
	assert.True(t, ok)
	assert.Equal(t, "value", val)

	time.Sleep(150 * time.Millisecond)
	_, ok = m.Get("key")
	assert.False(t, ok, "should expire after TTL")
}

func TestInMemoryLongTermMemory(t *testing.T) {
	m := NewInMemoryLongTermMemory()

	err := m.Set("solution", "use goroutines")
	require.NoError(t, err)

	val, ok := m.Get("solution")
	assert.True(t, ok)
	assert.Equal(t, "use goroutines", val)

	results, err := m.Search("sol")
	require.NoError(t, err)
	assert.Len(t, results, 1)

	err = m.Delete("solution")
	require.NoError(t, err)
	_, ok = m.Get("solution")
	assert.False(t, ok)
}

func TestInMemoryEpisodicMemory(t *testing.T) {
	m := NewInMemoryEpisodicMemory()

	err := m.Record(&MemoryEntry{ID: "e1", Key: "task-1", Value: "completed"})
	require.NoError(t, err)
	err = m.Record(&MemoryEntry{ID: "e2", Key: "task-2", Value: "completed"})
	require.NoError(t, err)

	recent, err := m.GetRecent(1)
	require.NoError(t, err)
	assert.Len(t, recent, 1)
	assert.Equal(t, "e2", recent[0].ID)

	results, err := m.Search("task-1")
	require.NoError(t, err)
	assert.Len(t, results, 1)
}

func TestAgentMemory(t *testing.T) {
	m := NewAgentMemory()
	assert.NotNil(t, m.Working)
	assert.NotNil(t, m.ShortTerm)
	assert.NotNil(t, m.LongTerm)
	assert.NotNil(t, m.Episodic)
}

func TestFileLongTermMemory(t *testing.T) {
	path := filepath.Join(t.TempDir(), "memory.json")
	m, err := NewFileLongTermMemory(path)
	require.NoError(t, err)

	err = m.Set("key", "persistent value")
	require.NoError(t, err)

	val, ok := m.Get("key")
	assert.True(t, ok)
	assert.Equal(t, "persistent value", val)

	// Reload from file
	m2, err := NewFileLongTermMemory(path)
	require.NoError(t, err)
	val, ok = m2.Get("key")
	assert.True(t, ok)
}

func TestFileEpisodicMemory(t *testing.T) {
	path := filepath.Join(t.TempDir(), "episodes.jsonl")
	m := NewFileEpisodicMemory(path)

	err := m.Record(&MemoryEntry{ID: "e1", Key: "task-1"})
	require.NoError(t, err)

	recent, err := m.GetRecent(10)
	require.NoError(t, err)
	assert.Len(t, recent, 1)
}
