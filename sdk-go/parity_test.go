package aisdlc

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"sort"
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
	"complianceMappings":   "compliance/mappings.go",
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
			if section == "complianceMappings" {
				isDefined = sdkDefinedNames(section, text)[name]
			}
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

// sdkDefinedNames returns the names the SDK source text defines for a manifest section.
func sdkDefinedNames(section, text string) map[string]bool {
	out := map[string]bool{}
	add := func(re string, src string) {
		for _, m := range regexp.MustCompile(re).FindAllStringSubmatch(src, -1) {
			out[m[1]] = true
		}
	}
	// block returns the struct literal assigned to `var name = struct {`.
	block := func(name string) string {
		i := strings.Index(text, "var "+name+" = struct {")
		if i < 0 {
			return ""
		}
		rest := text[i:]
		if j := strings.Index(rest, "\n}{\n"); j >= 0 {
			if k := strings.Index(rest[j:], "\n}\n"); k >= 0 {
				return rest[j : j+k]
			}
		}
		return rest
	}
	switch section {
	case "resourceKinds":
		add(`Kind\w+\s+ResourceKind = "([^"]+)"`, text)
	case "standardMetrics":
		add(`\{Name: "([^"]+)"`, text)
	case "spanNames":
		add(`\w+:\s+"([^"]+)"`, block("SpanNames"))
	case "metricNames":
		add(`\w+:\s+"([^"]+)"`, block("MetricNames"))
	case "attributeKeys":
		add(`\w+:\s+"([^"]+)"`, block("AttributeKeys"))
	case "complianceControls":
		add(`\{ID: "([^"]+)"`, text)
	case "regulatoryFrameworks":
		add(`Framework\w+\s+Framework = "([^"]+)"`, text)
	case "complianceMappings":
		for row := range mappingRows(text) {
			out[row] = true
		}
	}
	return out
}

// mappingRows returns each ControlMapping literal as
// `framework|controlId|frameworkReference|description` (AISDLC-1394).
func mappingRows(text string) map[string]bool {
	frameworks := map[string]string{}
	for _, m := range regexp.MustCompile(`(Framework\w+)\s+Framework = "([^"]+)"`).FindAllStringSubmatch(text, -1) {
		frameworks[m[1]] = m[2]
	}
	rows := map[string]bool{}
	re := regexp.MustCompile(`\{ControlID: "([^"]+)", Framework: (\w+), FrameworkReference: "([^"]+)", Description: "([^"]+)"\}`)
	for _, m := range re.FindAllStringSubmatch(text, -1) {
		rows[strings.Join([]string{frameworks[m[2]], m[1], m[3], m[4]}, "|")] = true
	}
	return rows
}

// sdkOnlyNames lists defined names that the manifest section lacks.
func sdkOnlyNames(defined map[string]bool, manifestNames []string) []string {
	known := map[string]bool{}
	for _, n := range manifestNames {
		known[n] = true
	}
	var extra []string
	for n := range defined {
		if !known[n] {
			extra = append(extra, n)
		}
	}
	sort.Strings(extra)
	return extra
}

func TestSDKDefinesNoNameAbsentFromManifest(t *testing.T) {
	var manifest map[string][]string
	readParityJSON(t, "manifest.json", &manifest)
	for section, names := range manifest {
		src, err := os.ReadFile(sectionFiles[section])
		require.NoError(t, err)
		defined := sdkDefinedNames(section, string(src))
		require.NotEmpty(t, defined, "extractor found no names for %s", section)
		require.Empty(t, sdkOnlyNames(defined, names), "%s: SDK defines names the reference lacks", section)
	}
}

func TestSDKOnlyNameIsDetected(t *testing.T) {
	cases := map[string]struct{ anchor, added string }{
		"resourceKinds":        {"\tKindPipeline ", "\tKindBogus ResourceKind = \"Bogus\"\n\tKindPipeline "},
		"standardMetrics":      {"\t{Name: \"approval-rate\"", "\t{Name: \"bogus-metric\"},\n\t{Name: \"approval-rate\""},
		"spanNames":            {"\tHandoff:  ", "\tBogus: \"ai_sdlc.bogus\",\n\tHandoff:  "},
		"metricNames":          {"\tTokensTotal:  ", "\tBogus: \"ai_sdlc.bogus.total\",\n\tTokensTotal:  "},
		"attributeKeys":        {"\tRunId:  ", "\tBogus: \"ai_sdlc.bogus\",\n\tRunId:  "},
		"complianceControls":   {"\t{ID: \"quality-gates\"", "\t{ID: \"bogus-control\"},\n\t{ID: \"quality-gates\""},
		"regulatoryFrameworks": {"\tFrameworkEUAIAct ", "\tFrameworkBogus Framework = \"bogus-framework\"\n\tFrameworkEUAIAct "},
		"complianceMappings":   {"\"Clause 9.2 - Internal Audit\"", "\"Clause 9.9 - Bogus\""},
	}
	var manifest map[string][]string
	readParityJSON(t, "manifest.json", &manifest)
	for section, c := range cases {
		src, err := os.ReadFile(sectionFiles[section])
		require.NoError(t, err)
		text := string(src)
		require.Contains(t, text, c.anchor, "anchor for %s", section)
		patched := strings.Replace(text, c.anchor, c.added, 1)
		require.Len(t, sdkOnlyNames(sdkDefinedNames(section, patched), manifest[section]), 1, section)
	}

	// A constructed name set: any name outside the manifest section is reported.
	require.Equal(t, []string{"x"}, sdkOnlyNames(map[string]bool{"a": true, "x": true}, []string{"a", "b"}))
	require.Empty(t, sdkOnlyNames(map[string]bool{"a": true}, []string{"a", "b"}))
}
