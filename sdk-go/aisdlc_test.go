package aisdlc

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestVersion(t *testing.T) {
	data, err := os.ReadFile("../.release-please-manifest.json")
	require.NoError(t, err)
	var manifest map[string]string
	require.NoError(t, json.Unmarshal(data, &manifest))
	assert.Equal(t, manifest["sdk-go"], Version)
}
