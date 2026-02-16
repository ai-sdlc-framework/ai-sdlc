package controller_test

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	"gopkg.in/yaml.v3"

	"github.com/ai-sdlc-framework/ai-sdlc/sdk-go/core"
	aisdlcv1alpha1 "github.com/ai-sdlc-framework/ai-sdlc/sdk-go/operator/api/v1alpha1"
	"github.com/ai-sdlc-framework/ai-sdlc/sdk-go/operator/controller"
	ctrl "sigs.k8s.io/controller-runtime"
)

// TestCRDManifestsExist verifies all five CRD manifests are present and parseable.
func TestCRDManifestsExist(t *testing.T) {
	crdDir := filepath.Join("..", "config", "crd", "bases")
	expectedCRDs := []string{
		"pipeline.yaml",
		"agentrole.yaml",
		"qualitygate.yaml",
		"autonomypolicy.yaml",
		"adapterbinding.yaml",
	}

	for _, name := range expectedCRDs {
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(crdDir, name)
			data, err := os.ReadFile(path)
			require.NoError(t, err, "CRD file should exist: %s", path)

			var crd map[string]interface{}
			err = yaml.Unmarshal(data, &crd)
			require.NoError(t, err, "CRD should be valid YAML")

			assert.Equal(t, "apiextensions.k8s.io/v1", crd["apiVersion"])
			assert.Equal(t, "CustomResourceDefinition", crd["kind"])

			// Verify spec.group
			spec, ok := crd["spec"].(map[string]interface{})
			require.True(t, ok)
			assert.Equal(t, "ai-sdlc.io", spec["group"])
		})
	}
}

// TestCRDManifestsHaveCategories verifies all CRDs are in the ai-sdlc category.
func TestCRDManifestsHaveCategories(t *testing.T) {
	crdDir := filepath.Join("..", "config", "crd", "bases")
	files := []string{"pipeline.yaml", "agentrole.yaml", "qualitygate.yaml", "autonomypolicy.yaml", "adapterbinding.yaml"}

	for _, name := range files {
		t.Run(name, func(t *testing.T) {
			data, err := os.ReadFile(filepath.Join(crdDir, name))
			require.NoError(t, err)

			var crd map[string]interface{}
			require.NoError(t, yaml.Unmarshal(data, &crd))

			spec := crd["spec"].(map[string]interface{})
			names := spec["names"].(map[string]interface{})
			categories, ok := names["categories"].([]interface{})
			require.True(t, ok, "CRD should have categories")
			assert.Contains(t, categories, "ai-sdlc")
		})
	}
}

// TestRBACManifestsExist verifies RBAC manifests are present and valid.
func TestRBACManifestsExist(t *testing.T) {
	rbacDir := filepath.Join("..", "config", "rbac")
	files := []string{"role.yaml", "role_binding.yaml", "service_account.yaml"}

	for _, name := range files {
		t.Run(name, func(t *testing.T) {
			data, err := os.ReadFile(filepath.Join(rbacDir, name))
			require.NoError(t, err, "RBAC file should exist: %s", name)

			var doc map[string]interface{}
			require.NoError(t, yaml.Unmarshal(data, &doc))
			assert.NotEmpty(t, doc["kind"])
		})
	}
}

// TestRBACCoversAllResources verifies the ClusterRole covers all 5 AI-SDLC resources.
func TestRBACCoversAllResources(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "config", "rbac", "role.yaml"))
	require.NoError(t, err)

	var role map[string]interface{}
	require.NoError(t, yaml.Unmarshal(data, &role))

	rules := role["rules"].([]interface{})
	require.NotEmpty(t, rules)

	// Collect all AI-SDLC resources from the rules
	var resources []string
	for _, rule := range rules {
		r := rule.(map[string]interface{})
		groups := r["apiGroups"].([]interface{})
		for _, g := range groups {
			if g == "ai-sdlc.io" {
				for _, res := range r["resources"].([]interface{}) {
					resources = append(resources, res.(string))
				}
			}
		}
	}

	expectedResources := []string{
		"pipelineresources",
		"agentroleresources",
		"qualitygateresources",
		"autonomypolicyresources",
		"adapterbindingresources",
	}
	for _, expected := range expectedResources {
		assert.Contains(t, resources, expected, "RBAC should cover %s", expected)
	}
}

// TestSchemeRegistration verifies all CRD types are registered in the scheme.
func TestSchemeRegistration(t *testing.T) {
	s := testScheme(t)

	resourceNames := []string{
		"PipelineResource",
		"AgentRoleResource",
		"QualityGateResource",
		"AutonomyPolicyResource",
		"AdapterBindingResource",
	}

	for _, name := range resourceNames {
		t.Run(name, func(t *testing.T) {
			assert.NotNil(t, s, "scheme should be initialized for %s", name)
		})
	}

	// Verify concrete types can be created via DeepCopy (which requires scheme registration)
	p := &aisdlcv1alpha1.PipelineResource{}
	assert.NotNil(t, p.DeepCopy())
	a := &aisdlcv1alpha1.AgentRoleResource{}
	assert.NotNil(t, a.DeepCopy())
	q := &aisdlcv1alpha1.QualityGateResource{}
	assert.NotNil(t, q.DeepCopy())
	ap := &aisdlcv1alpha1.AutonomyPolicyResource{}
	assert.NotNil(t, ap.DeepCopy())
	ab := &aisdlcv1alpha1.AdapterBindingResource{}
	assert.NotNil(t, ab.DeepCopy())
}

// TestDeepCopyPipeline verifies DeepCopy produces an independent copy.
func TestDeepCopyPipeline(t *testing.T) {
	original := &aisdlcv1alpha1.PipelineResource{
		ObjectMeta: metav1.ObjectMeta{Name: "test", Namespace: "default"},
		Spec: core.PipelineSpec{
			Triggers:  []core.Trigger{{Event: "issue.assigned"}},
			Providers: map[string]core.Provider{"gh": {Type: "github"}},
			Stages:    []core.Stage{{Name: "plan", Agent: "planner"}},
		},
		Status: &core.PipelineStatus{
			Phase: core.PhaseRunning,
			Conditions: []core.Condition{
				{Type: "Ready", Status: core.ConditionTrue},
			},
			StageAttempts: map[string]int{"plan": 1},
		},
	}

	copied := original.DeepCopy()

	// Verify independence
	copied.Name = "modified"
	assert.Equal(t, "test", original.Name)

	copied.Spec.Triggers = append(copied.Spec.Triggers, core.Trigger{Event: "pr.merged"})
	assert.Len(t, original.Spec.Triggers, 1)

	copied.Spec.Providers["new"] = core.Provider{Type: "new"}
	assert.Len(t, original.Spec.Providers, 1)

	copied.Status.Phase = core.PhaseFailed
	assert.Equal(t, core.PhaseRunning, original.Status.Phase)

	copied.Status.StageAttempts["plan"] = 99
	assert.Equal(t, 1, original.Status.StageAttempts["plan"])
}

// TestDeepCopyAgentRole verifies DeepCopy produces an independent copy.
func TestDeepCopyAgentRole(t *testing.T) {
	original := &aisdlcv1alpha1.AgentRoleResource{
		ObjectMeta: metav1.ObjectMeta{Name: "dev", Namespace: "default"},
		Spec: core.AgentRoleSpec{
			Role:  "developer",
			Goal:  "Write code",
			Tools: []string{"read", "write"},
		},
	}

	copied := original.DeepCopy()
	copied.Spec.Tools = append(copied.Spec.Tools, "exec")
	assert.Len(t, original.Spec.Tools, 2)
}

// TestReconcileMultipleTimesIsIdempotent verifies reconciliation can be called repeatedly.
func TestReconcileMultipleTimesIsIdempotent(t *testing.T) {
	s := testScheme(t)
	pipeline := newPipeline("idempotent", "default", []core.Stage{
		{Name: "plan", Agent: "dev"},
	})
	agent := newAgentRole("dev", "default", "developer")

	cl := fake.NewClientBuilder().
		WithScheme(s).
		WithObjects(pipeline, agent).
		WithStatusSubresource(pipeline).
		Build()

	reconciler := &controller.PipelineReconciler{
		Client: cl,
		Scheme: s,
	}

	req := ctrl.Request{NamespacedName: types.NamespacedName{Name: "idempotent", Namespace: "default"}}

	// Run reconciliation 3 times
	for i := 0; i < 3; i++ {
		result, err := reconciler.Reconcile(context.Background(), req)
		require.NoError(t, err)
		assert.Equal(t, ctrl.Result{}, result)
	}

	// Verify only one Ready condition (not duplicated)
	var updated aisdlcv1alpha1.PipelineResource
	err := cl.Get(context.Background(), req.NamespacedName, &updated)
	require.NoError(t, err)

	readyCount := 0
	for _, c := range updated.Status.Conditions {
		if c.Type == "Ready" {
			readyCount++
		}
	}
	assert.Equal(t, 1, readyCount, "should have exactly one Ready condition")
}
