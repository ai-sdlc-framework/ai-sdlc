package aisdlc

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// sectionFiles maps each manifest section to the SDK file that must define its names.
var sectionFiles = map[string]string{
	"resourceKinds":        "core/types.go",
	"standardMetrics":      "metrics/types.go",
	"spanNames":            "telemetry/conventions.go",
	"metricNames":          "telemetry/conventions.go",
	"attributeKeys":        "telemetry/conventions.go",
	"complianceControls":   "compliance/mappings.go",
	"regulatoryFrameworks": "compliance/mappings.go",
}

func readParityJSON(t *testing.T, name string, out any) {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "conformance", "parity", name))
	require.NoError(t, err)
	require.NoError(t, json.Unmarshal(data, out))
}

func TestParityWithReferenceManifest(t *testing.T) {
	var manifest map[string][]string
	readParityJSON(t, "manifest.json", &manifest)
	var exemptions map[string]map[string][]string
	readParityJSON(t, "exemptions.json", &exemptions)
	exempt := exemptions["go"]

	require.Len(t, manifest, len(sectionFiles))
	for section, names := range manifest {
		file, ok := sectionFiles[section]
		require.True(t, ok, "manifest section %q has no SDK source mapping", section)
		src, err := os.ReadFile(file)
		require.NoError(t, err)
		text := string(src)

		exemptSet := map[string]bool{}
		for _, n := range exempt[section] {
			exemptSet[n] = true
		}
		inManifest := map[string]bool{}
		for _, name := range names {
			inManifest[name] = true
			isDefined := strings.Contains(text, strconv.Quote(name))
			if exemptSet[name] {
				if isDefined {
					t.Errorf("%s/%s is defined; remove it from exemptions.json", section, name)
				}
			} else if !isDefined {
				t.Errorf("%s/%s is neither defined in the SDK nor exempt", section, name)
			}
		}
		for n := range exemptSet {
			if !inManifest[n] {
				t.Errorf("stale exemption %s/%s", section, n)
			}
		}
	}
	for section := range exempt {
		_, ok := manifest[section]
		require.True(t, ok, "exemption section %q not in manifest", section)
	}
}
