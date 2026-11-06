package audit

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const conformanceDir = "../../conformance/audit-chain"

type fixtureFile struct {
	SchemaVersion  string                   `json:"schemaVersion"`
	Inputs         []map[string]interface{} `json:"inputs"`
	ExpectedHashes []string                 `json:"expectedHashes"`
}

func loadFixture(t *testing.T) fixtureFile {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(conformanceDir, "fixture.json"))
	require.NoError(t, err)
	var f fixtureFile
	require.NoError(t, json.Unmarshal(raw, &f))
	return f
}

func str(m map[string]interface{}, k string) string {
	s, _ := m[k].(string)
	return s
}

func sealFixture(f fixtureFile) []*AuditEntry {
	var out []*AuditEntry
	prev := ""
	for _, in := range f.Inputs {
		e := &AuditEntry{
			SchemaVersion: f.SchemaVersion,
			ID:            str(in, "id"),
			Timestamp:     str(in, "timestamp"),
			Actor:         str(in, "actor"),
			Action:        str(in, "action"),
			Resource:      str(in, "resource"),
			Decision:      str(in, "decision"),
			Policy:        str(in, "policy"),
			PreviousHash:  prev,
		}
		if d, ok := in["details"].(map[string]interface{}); ok {
			e.Details = d
		}
		e.Hash = ComputeEntryHash(e)
		prev = e.Hash
		out = append(out, e)
	}
	return out
}

func TestConformanceFixtureHashes(t *testing.T) {
	f := loadFixture(t)
	entries := sealFixture(f)
	var hashes []string
	for _, e := range entries {
		hashes = append(hashes, e.Hash)
	}
	assert.Equal(t, f.ExpectedHashes, hashes)

	if os.Getenv("AUDIT_CONFORMANCE_WRITE") != "" {
		path := filepath.Join(conformanceDir, "samples", "go.jsonl")
		require.NoError(t, os.WriteFile(path, nil, 0o644))
		sink, err := NewFileSink(path)
		require.NoError(t, err)
		for _, e := range entries {
			require.NoError(t, sink.Write(e))
		}
		require.NoError(t, sink.Close())
	}
}

func TestConformanceVerifiesEverySDKSample(t *testing.T) {
	for _, name := range []string{"typescript", "go", "python"} {
		ok, err := VerifyFileIntegrity(filepath.Join(conformanceDir, "samples", name+".jsonl"))
		require.NoError(t, err, name)
		assert.True(t, ok, name)
	}
}

func TestConformanceOneByteChangeFails(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join(conformanceDir, "samples", "python.jsonl"))
	require.NoError(t, err)
	p := filepath.Join(t.TempDir(), "t.jsonl")
	require.NoError(t, os.WriteFile(p, []byte(strings.Replace(string(raw), "policy/strict", "policy/strict2", 1)), 0o644))
	ok, err := VerifyFileIntegrity(p)
	require.NoError(t, err)
	assert.False(t, ok)
}

func TestLegacyChainStillVerifies(t *testing.T) {
	f := loadFixture(t)
	var entries []*AuditEntry
	prev := "genesis"
	for _, in := range f.Inputs {
		e := &AuditEntry{
			ID: str(in, "id"), Timestamp: str(in, "timestamp"), Actor: str(in, "actor"),
			Action: str(in, "action"), ResourceKind: "Pipeline", ResourceName: "p",
			Outcome: str(in, "decision"), PreviousHash: prev,
		}
		e.Hash = ComputeEntryHash(e)
		prev = e.Hash
		entries = append(entries, e)
	}
	assert.True(t, VerifyEntries(entries))
	entries[1].Actor = "mallory"
	assert.False(t, VerifyEntries(entries))
}

func TestCanonicalNumbers(t *testing.T) {
	cases := map[float64]string{1: "1", 2.5: "2.5", 1e21: "1e+21", 1e-7: "1e-7", 1e-6: "0.000001", 1.5e-9: "1.5e-9", 123456789012345680000: "123456789012345680000", -3: "-3"}
	for in, want := range cases {
		assert.Equal(t, want, formatNumber(in))
	}
	assert.Equal(t, "0", formatNumber(0))
}

func TestCanonicalizeValue(t *testing.T) {
	got := canonicalizeValue(map[string]interface{}{
		"b": "<&>é \x01", "a": []interface{}{1, 2.5, nil, true, "\"\\\b\f\n\r\t"}, "\U0001F600": 1,
	})
	assert.Equal(t, "{\"a\":[1,2.5,null,true,\"\\\"\\\\\\b\\f\\n\\r\\t\"],\"b\":\"<&>é \\u0001\",\"\U0001F600\":1}", got)
	assert.Panics(t, func() { canonicalizeValue(make(chan int)) })
}
