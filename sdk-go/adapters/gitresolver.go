package adapters

import (
	"fmt"
	"regexp"
	"strings"
)

// GitAdapterRef represents a parsed git adapter reference.
type GitAdapterRef struct {
	Repo string `json:"repo"`
	Ref  string `json:"ref"`
	Path string `json:"path,omitempty"`
}

var gitRefPattern = regexp.MustCompile(`^(https?://[^@]+)@([^:]+)(?::(.+))?$`)

// ParseGitAdapterRef parses a git adapter reference string.
// Format: "https://github.com/org/repo@tag:path/to/adapter"
func ParseGitAdapterRef(ref string) (*GitAdapterRef, error) {
	m := gitRefPattern.FindStringSubmatch(ref)
	if m == nil {
		// Try simple repo@ref format
		parts := strings.SplitN(ref, "@", 2)
		if len(parts) != 2 {
			return nil, fmt.Errorf("invalid git adapter reference: %s", ref)
		}
		refAndPath := strings.SplitN(parts[1], ":", 2)
		result := &GitAdapterRef{Repo: parts[0], Ref: refAndPath[0]}
		if len(refAndPath) > 1 {
			result.Path = refAndPath[1]
		}
		return result, nil
	}

	return &GitAdapterRef{
		Repo: m[1],
		Ref:  m[2],
		Path: m[3],
	}, nil
}

// ResolveGitAdapter resolves a git adapter reference to metadata.
func ResolveGitAdapter(ref string) (*AdapterMetadata, error) {
	parsed, err := ParseGitAdapterRef(ref)
	if err != nil {
		return nil, err
	}
	return &AdapterMetadata{
		Name:    parsed.Path,
		Source:  parsed.Repo + "@" + parsed.Ref,
		Version: parsed.Ref,
	}, nil
}
