package controller_test

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	"github.com/ai-sdlc-framework/ai-sdlc/sdk-go/core"
	aisdlcv1alpha1 "github.com/ai-sdlc-framework/ai-sdlc/sdk-go/operator/api/v1alpha1"
	"github.com/ai-sdlc-framework/ai-sdlc/sdk-go/operator/controller"
)

func newPipeline(name, namespace string, stages []core.Stage) *aisdlcv1alpha1.PipelineResource {
	return &aisdlcv1alpha1.PipelineResource{
		ObjectMeta: metav1.ObjectMeta{
			Name:      name,
			Namespace: namespace,
		},
		Spec: core.PipelineSpec{
			Triggers:  []core.Trigger{{Event: "issue.assigned"}},
			Providers: map[string]core.Provider{"issueTracker": {Type: "linear"}},
			Stages:    stages,
		},
	}
}

func newAgentRole(name, namespace, role string) *aisdlcv1alpha1.AgentRoleResource {
	return &aisdlcv1alpha1.AgentRoleResource{
		ObjectMeta: metav1.ObjectMeta{
			Name:      name,
			Namespace: namespace,
		},
		Spec: core.AgentRoleSpec{
			Role:  role,
			Goal:  "Test goal",
			Tools: []string{"read", "write"},
		},
	}
}

func newQualityGate(name, namespace string) *aisdlcv1alpha1.QualityGateResource {
	threshold := float64(80)
	return &aisdlcv1alpha1.QualityGateResource{
		ObjectMeta: metav1.ObjectMeta{
			Name:      name,
			Namespace: namespace,
		},
		Spec: core.QualityGateSpec{
			Gates: []core.Gate{
				{
					Name:        "coverage",
					Enforcement: core.EnforcementHardMandatory,
					Rule: core.GateRule{
						Metric:    "coverage",
						Operator:  ">=",
						Threshold: &threshold,
					},
				},
			},
		},
	}
}

func TestReconcile_NotFound(t *testing.T) {
	s := testScheme(t)
	cl := fake.NewClientBuilder().WithScheme(s).Build()

	reconciler := &controller.PipelineReconciler{
		Client: cl,
		Scheme: s,
	}

	result, err := reconciler.Reconcile(context.Background(), ctrl.Request{
		NamespacedName: types.NamespacedName{Name: "nonexistent", Namespace: "default"},
	})

	require.NoError(t, err)
	assert.Equal(t, ctrl.Result{}, result)
}

func TestReconcile_NoAgentsNoGates(t *testing.T) {
	s := testScheme(t)
	pipeline := newPipeline("simple", "default", []core.Stage{
		{Name: "plan"},
	})

	cl := fake.NewClientBuilder().
		WithScheme(s).
		WithObjects(pipeline).
		WithStatusSubresource(pipeline).
		Build()

	reconciler := &controller.PipelineReconciler{
		Client: cl,
		Scheme: s,
	}

	result, err := reconciler.Reconcile(context.Background(), ctrl.Request{
		NamespacedName: types.NamespacedName{Name: "simple", Namespace: "default"},
	})

	require.NoError(t, err)
	assert.Equal(t, ctrl.Result{}, result)

	// Verify status was updated
	var updated aisdlcv1alpha1.PipelineResource
	err = cl.Get(context.Background(), types.NamespacedName{Name: "simple", Namespace: "default"}, &updated)
	require.NoError(t, err)
	require.NotNil(t, updated.Status)
	require.Len(t, updated.Status.Conditions, 1)
	assert.Equal(t, "Ready", updated.Status.Conditions[0].Type)
	assert.Equal(t, core.ConditionTrue, updated.Status.Conditions[0].Status)
}

func TestReconcile_ResolvesAgents(t *testing.T) {
	s := testScheme(t)
	pipeline := newPipeline("with-agent", "default", []core.Stage{
		{Name: "plan", Agent: "planner"},
	})
	agent := newAgentRole("planner", "default", "planner")

	cl := fake.NewClientBuilder().
		WithScheme(s).
		WithObjects(pipeline, agent).
		WithStatusSubresource(pipeline).
		Build()

	reconciler := &controller.PipelineReconciler{
		Client: cl,
		Scheme: s,
	}

	result, err := reconciler.Reconcile(context.Background(), ctrl.Request{
		NamespacedName: types.NamespacedName{Name: "with-agent", Namespace: "default"},
	})

	require.NoError(t, err)
	assert.Equal(t, ctrl.Result{}, result)

	var updated aisdlcv1alpha1.PipelineResource
	err = cl.Get(context.Background(), types.NamespacedName{Name: "with-agent", Namespace: "default"}, &updated)
	require.NoError(t, err)
	assert.Contains(t, updated.Status.Conditions[0].Message, "1 agents")
}

func TestReconcile_AgentNotFound(t *testing.T) {
	s := testScheme(t)
	pipeline := newPipeline("missing-agent", "default", []core.Stage{
		{Name: "plan", Agent: "nonexistent"},
	})

	cl := fake.NewClientBuilder().
		WithScheme(s).
		WithObjects(pipeline).
		WithStatusSubresource(pipeline).
		Build()

	reconciler := &controller.PipelineReconciler{
		Client: cl,
		Scheme: s,
	}

	result, err := reconciler.Reconcile(context.Background(), ctrl.Request{
		NamespacedName: types.NamespacedName{Name: "missing-agent", Namespace: "default"},
	})

	require.NoError(t, err)
	assert.NotZero(t, result.RequeueAfter)

	var updated aisdlcv1alpha1.PipelineResource
	err = cl.Get(context.Background(), types.NamespacedName{Name: "missing-agent", Namespace: "default"}, &updated)
	require.NoError(t, err)
	assert.Equal(t, core.ConditionFalse, updated.Status.Conditions[0].Status)
	assert.Contains(t, updated.Status.Conditions[0].Message, "not found")
}

func TestReconcile_ResolvesQualityGates(t *testing.T) {
	s := testScheme(t)
	pipeline := newPipeline("with-gate", "default", []core.Stage{
		{Name: "review", QualityGates: []string{"coverage-gate"}},
	})
	gate := newQualityGate("coverage-gate", "default")

	cl := fake.NewClientBuilder().
		WithScheme(s).
		WithObjects(pipeline, gate).
		WithStatusSubresource(pipeline).
		Build()

	reconciler := &controller.PipelineReconciler{
		Client: cl,
		Scheme: s,
	}

	result, err := reconciler.Reconcile(context.Background(), ctrl.Request{
		NamespacedName: types.NamespacedName{Name: "with-gate", Namespace: "default"},
	})

	require.NoError(t, err)
	assert.Equal(t, ctrl.Result{}, result)

	var updated aisdlcv1alpha1.PipelineResource
	err = cl.Get(context.Background(), types.NamespacedName{Name: "with-gate", Namespace: "default"}, &updated)
	require.NoError(t, err)
	assert.Contains(t, updated.Status.Conditions[0].Message, "1 gates")
}

func TestReconcile_QualityGateNotFound(t *testing.T) {
	s := testScheme(t)
	pipeline := newPipeline("missing-gate", "default", []core.Stage{
		{Name: "review", QualityGates: []string{"nonexistent"}},
	})

	cl := fake.NewClientBuilder().
		WithScheme(s).
		WithObjects(pipeline).
		WithStatusSubresource(pipeline).
		Build()

	reconciler := &controller.PipelineReconciler{
		Client: cl,
		Scheme: s,
	}

	result, err := reconciler.Reconcile(context.Background(), ctrl.Request{
		NamespacedName: types.NamespacedName{Name: "missing-gate", Namespace: "default"},
	})

	require.NoError(t, err)
	assert.NotZero(t, result.RequeueAfter)

	var updated aisdlcv1alpha1.PipelineResource
	err = cl.Get(context.Background(), types.NamespacedName{Name: "missing-gate", Namespace: "default"}, &updated)
	require.NoError(t, err)
	assert.Equal(t, core.ConditionFalse, updated.Status.Conditions[0].Status)
}

func TestReconcile_FullPipeline(t *testing.T) {
	s := testScheme(t)
	pipeline := newPipeline("full", "default", []core.Stage{
		{Name: "plan", Agent: "planner"},
		{Name: "implement", Agent: "developer", QualityGates: []string{"coverage-gate"}},
		{Name: "review", Agent: "reviewer"},
	})
	planner := newAgentRole("planner", "default", "planner")
	developer := newAgentRole("developer", "default", "developer")
	reviewer := newAgentRole("reviewer", "default", "reviewer")
	gate := newQualityGate("coverage-gate", "default")

	cl := fake.NewClientBuilder().
		WithScheme(s).
		WithObjects(pipeline, planner, developer, reviewer, gate).
		WithStatusSubresource(pipeline).
		Build()

	reconciler := &controller.PipelineReconciler{
		Client: cl,
		Scheme: s,
	}

	result, err := reconciler.Reconcile(context.Background(), ctrl.Request{
		NamespacedName: types.NamespacedName{Name: "full", Namespace: "default"},
	})

	require.NoError(t, err)
	assert.Equal(t, ctrl.Result{}, result)

	var updated aisdlcv1alpha1.PipelineResource
	err = cl.Get(context.Background(), types.NamespacedName{Name: "full", Namespace: "default"}, &updated)
	require.NoError(t, err)
	assert.Equal(t, core.ConditionTrue, updated.Status.Conditions[0].Status)
	assert.Contains(t, updated.Status.Conditions[0].Message, "3 agents")
	assert.Contains(t, updated.Status.Conditions[0].Message, "1 gates")
}

func TestReconcile_DuplicateAgentsDeduped(t *testing.T) {
	s := testScheme(t)
	pipeline := newPipeline("dedup", "default", []core.Stage{
		{Name: "plan", Agent: "dev"},
		{Name: "implement", Agent: "dev"},
		{Name: "review", Agent: "dev"},
	})
	dev := newAgentRole("dev", "default", "developer")

	cl := fake.NewClientBuilder().
		WithScheme(s).
		WithObjects(pipeline, dev).
		WithStatusSubresource(pipeline).
		Build()

	reconciler := &controller.PipelineReconciler{
		Client: cl,
		Scheme: s,
	}

	result, err := reconciler.Reconcile(context.Background(), ctrl.Request{
		NamespacedName: types.NamespacedName{Name: "dedup", Namespace: "default"},
	})

	require.NoError(t, err)
	assert.Equal(t, ctrl.Result{}, result)

	var updated aisdlcv1alpha1.PipelineResource
	err = cl.Get(context.Background(), types.NamespacedName{Name: "dedup", Namespace: "default"}, &updated)
	require.NoError(t, err)
	assert.Contains(t, updated.Status.Conditions[0].Message, "1 agents")
}

func TestReconcile_StatusInitialization(t *testing.T) {
	s := testScheme(t)
	pipeline := newPipeline("no-status", "default", []core.Stage{
		{Name: "plan"},
	})

	cl := fake.NewClientBuilder().
		WithScheme(s).
		WithObjects(pipeline).
		WithStatusSubresource(pipeline).
		Build()

	reconciler := &controller.PipelineReconciler{
		Client: cl,
		Scheme: s,
	}

	_, err := reconciler.Reconcile(context.Background(), ctrl.Request{
		NamespacedName: types.NamespacedName{Name: "no-status", Namespace: "default"},
	})

	require.NoError(t, err)

	var updated aisdlcv1alpha1.PipelineResource
	err = cl.Get(context.Background(), types.NamespacedName{Name: "no-status", Namespace: "default"}, &updated)
	require.NoError(t, err)
	require.NotNil(t, updated.Status)
	assert.Equal(t, core.PhasePending, updated.Status.Phase)
}

func TestGatherAgentNames(t *testing.T) {
	stages := []core.Stage{
		{Name: "a", Agent: "planner"},
		{Name: "b", Agent: "developer"},
		{Name: "c", Agent: "planner"},
		{Name: "d"},
	}
	names := controller.GatherAgentNames(stages)
	assert.Equal(t, []string{"planner", "developer"}, names)
}

func TestGatherQualityGateNames(t *testing.T) {
	stages := []core.Stage{
		{Name: "a", QualityGates: []string{"gate-a", "gate-b"}},
		{Name: "b", QualityGates: []string{"gate-a"}},
		{Name: "c"},
	}
	names := controller.GatherQualityGateNames(stages)
	assert.Equal(t, []string{"gate-a", "gate-b"}, names)
}
