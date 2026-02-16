package core

import (
	"embed"
	"encoding/json"
	"fmt"
	"strings"
	"sync"

	"github.com/santhosh-tekuri/jsonschema/v6"
)

//go:embed schemas/*.json
var schemaFS embed.FS

// SchemaFiles maps resource kinds to their schema file names.
var SchemaFiles = map[ResourceKind]string{
	KindPipeline:       "pipeline.schema.json",
	KindAgentRole:      "agent-role.schema.json",
	KindQualityGate:    "quality-gate.schema.json",
	KindAutonomyPolicy: "autonomy-policy.schema.json",
	KindAdapterBinding: "adapter-binding.schema.json",
}

// ValidationError represents a single validation error.
type ValidationError struct {
	Path    string `json:"path"`
	Message string `json:"message"`
	Keyword string `json:"keyword"`
}

// ValidationResult contains the outcome of schema validation.
type ValidationResult struct {
	Valid  bool              `json:"valid"`
	Data   interface{}       `json:"data,omitempty"`
	Errors []ValidationError `json:"errors,omitempty"`
}

var (
	compiler     *jsonschema.Compiler
	compilerOnce sync.Once
	compilerErr  error
)

func getCompiler() (*jsonschema.Compiler, error) {
	compilerOnce.Do(func() {
		c := jsonschema.NewCompiler()
		// Load all schemas from embedded FS
		entries, err := schemaFS.ReadDir("schemas")
		if err != nil {
			compilerErr = fmt.Errorf("failed to read embedded schemas: %w", err)
			return
		}
		for _, entry := range entries {
			if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
				continue
			}
			data, err := schemaFS.ReadFile("schemas/" + entry.Name())
			if err != nil {
				compilerErr = fmt.Errorf("failed to read schema %s: %w", entry.Name(), err)
				return
			}
			var schema interface{}
			if err := json.Unmarshal(data, &schema); err != nil {
				compilerErr = fmt.Errorf("failed to parse schema %s: %w", entry.Name(), err)
				return
			}
			schemaID := "https://ai-sdlc.io/schemas/v1alpha1/" + entry.Name()
			if err := c.AddResource(schemaID, schema); err != nil {
				compilerErr = fmt.Errorf("failed to add schema %s: %w", entry.Name(), err)
				return
			}
		}
		compiler = c
	})
	return compiler, compilerErr
}

// Validate validates a resource document against the schema for the given kind.
func Validate(kind ResourceKind, data interface{}) *ValidationResult {
	schemaFile, ok := SchemaFiles[kind]
	if !ok {
		return &ValidationResult{
			Valid:  false,
			Errors: []ValidationError{{Path: "/", Message: fmt.Sprintf("unknown resource kind: %s", kind), Keyword: "enum"}},
		}
	}

	c, err := getCompiler()
	if err != nil {
		return &ValidationResult{
			Valid:  false,
			Errors: []ValidationError{{Path: "/", Message: fmt.Sprintf("schema compiler error: %v", err), Keyword: "internal"}},
		}
	}

	schemaID := "https://ai-sdlc.io/schemas/v1alpha1/" + schemaFile
	sch, err := c.Compile(schemaID)
	if err != nil {
		return &ValidationResult{
			Valid:  false,
			Errors: []ValidationError{{Path: "/", Message: fmt.Sprintf("schema compilation error: %v", err), Keyword: "internal"}},
		}
	}

	if err := sch.Validate(data); err != nil {
		verr, ok := err.(*jsonschema.ValidationError)
		if !ok {
			return &ValidationResult{
				Valid:  false,
				Errors: []ValidationError{{Path: "/", Message: err.Error(), Keyword: "internal"}},
			}
		}
		return &ValidationResult{
			Valid:  false,
			Errors: flattenValidationErrors(verr),
		}
	}

	return &ValidationResult{Valid: true, Data: data}
}

// ValidateResource validates a resource by inferring its kind from the document.
func ValidateResource(data interface{}) *ValidationResult {
	m, ok := data.(map[string]interface{})
	if !ok {
		return &ValidationResult{
			Valid:  false,
			Errors: []ValidationError{{Path: "/", Message: "expected a map/object", Keyword: "type"}},
		}
	}

	kindVal, ok := m["kind"]
	if !ok {
		return &ValidationResult{
			Valid:  false,
			Errors: []ValidationError{{Path: "/", Message: `missing "kind" field`, Keyword: "required"}},
		}
	}

	kind, ok := kindVal.(string)
	if !ok {
		return &ValidationResult{
			Valid:  false,
			Errors: []ValidationError{{Path: "/kind", Message: `"kind" must be a string`, Keyword: "type"}},
		}
	}

	rk := ResourceKind(kind)
	if _, exists := SchemaFiles[rk]; !exists {
		return &ValidationResult{
			Valid:  false,
			Errors: []ValidationError{{Path: "/kind", Message: fmt.Sprintf("unknown resource kind: %s", kind), Keyword: "enum"}},
		}
	}

	return Validate(rk, data)
}

func flattenValidationErrors(verr *jsonschema.ValidationError) []ValidationError {
	var errs []ValidationError
	collectErrors(verr, &errs)
	if len(errs) == 0 {
		errs = append(errs, ValidationError{
			Path:    formatInstanceLocation(verr.InstanceLocation),
			Message: verr.Error(),
			Keyword: "unknown",
		})
	}
	return errs
}

func collectErrors(verr *jsonschema.ValidationError, errs *[]ValidationError) {
	if len(verr.Causes) == 0 {
		path := formatInstanceLocation(verr.InstanceLocation)
		msg := fmt.Sprintf("%v", verr.ErrorKind)
		keyword := extractKeyword(verr)
		*errs = append(*errs, ValidationError{
			Path:    path,
			Message: msg,
			Keyword: keyword,
		})
		return
	}
	for _, cause := range verr.Causes {
		collectErrors(cause, errs)
	}
}

func formatInstanceLocation(loc []string) string {
	if len(loc) == 0 {
		return "/"
	}
	return "/" + strings.Join(loc, "/")
}

func extractKeyword(verr *jsonschema.ValidationError) string {
	parts := strings.Split(verr.SchemaURL, "/")
	if len(parts) > 0 {
		return parts[len(parts)-1]
	}
	return "unknown"
}
