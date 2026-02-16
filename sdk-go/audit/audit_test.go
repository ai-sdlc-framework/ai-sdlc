package audit

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestAuditLogAndVerify(t *testing.T) {
	sink := NewInMemoryAuditSink()
	log := NewAuditLog(sink)

	err := log.Log("create", "Pipeline", "my-pipeline", "alice", "success", nil)
	require.NoError(t, err)

	err = log.Log("update", "Pipeline", "my-pipeline", "bob", "success", map[string]interface{}{"field": "spec"})
	require.NoError(t, err)

	assert.Len(t, sink.Entries, 2)
	assert.NotEmpty(t, sink.Entries[0].Hash)
	assert.Equal(t, "genesis", sink.Entries[0].PreviousHash)
	assert.Equal(t, sink.Entries[0].Hash, sink.Entries[1].PreviousHash)

	valid, err := log.Verify()
	require.NoError(t, err)
	assert.True(t, valid)
}

func TestAuditQuery(t *testing.T) {
	log := NewAuditLog()
	log.Log("create", "Pipeline", "p1", "alice", "success", nil)
	log.Log("update", "AgentRole", "a1", "bob", "success", nil)
	log.Log("delete", "Pipeline", "p1", "alice", "success", nil)

	results, err := log.Query(&AuditFilter{Action: "create"})
	require.NoError(t, err)
	assert.Len(t, results, 1)

	results, err = log.Query(&AuditFilter{Actor: "alice"})
	require.NoError(t, err)
	assert.Len(t, results, 2)
}

func TestFileSink(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "audit.jsonl")

	sink, err := NewFileSink(path)
	require.NoError(t, err)
	defer sink.Close()

	log := NewAuditLog(sink)
	log.Log("create", "Pipeline", "p1", "alice", "success", nil)
	log.Log("update", "Pipeline", "p1", "alice", "success", nil)

	entries, err := LoadEntriesFromFile(path)
	require.NoError(t, err)
	assert.Len(t, entries, 2)

	valid, err := VerifyFileIntegrity(path)
	require.NoError(t, err)
	assert.True(t, valid)
}

func TestRotateAuditFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "audit.jsonl")
	archivePath := filepath.Join(dir, "audit.jsonl.1")

	sink, err := NewFileSink(path)
	require.NoError(t, err)

	log := NewAuditLog(sink)
	log.Log("create", "Pipeline", "p1", "alice", "success", nil)

	err = RotateAuditFile(sink, archivePath)
	require.NoError(t, err)

	_, err = os.Stat(archivePath)
	assert.NoError(t, err)
}
