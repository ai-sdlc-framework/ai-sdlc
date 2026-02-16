// Package controller implements Kubernetes reconcilers for AI-SDLC resources.
package controller

import (
	"context"
	"fmt"
	"time"

	"k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/log"

	"github.com/ai-sdlc-framework/ai-sdlc/sdk-go/core"
	aisdlcv1alpha1 "github.com/ai-sdlc-framework/ai-sdlc/sdk-go/operator/api/v1alpha1"
)

// PipelineReconciler reconciles PipelineResource objects.
type PipelineReconciler struct {
	client.Client
	Scheme *runtime.Scheme
}

// +kubebuilder:rbac:groups=ai-sdlc.io,resources=pipelineresources,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=ai-sdlc.io,resources=pipelineresources/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=ai-sdlc.io,resources=pipelineresources/finalizers,verbs=update

// Reconcile handles a single reconciliation loop for a PipelineResource.
func (r *PipelineReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	logger := log.FromContext(ctx)

	// 1. Fetch the PipelineResource
	var pipeline aisdlcv1alpha1.PipelineResource
	if err := r.Get(ctx, req.NamespacedName, &pipeline); err != nil {
		if errors.IsNotFound(err) {
			logger.Info("PipelineResource not found, ignoring")
			return ctrl.Result{}, nil
		}
		return ctrl.Result{}, fmt.Errorf("fetching pipeline: %w", err)
	}

	// 2. Initialize status if nil
	if pipeline.Status == nil {
		pipeline.Status = &core.PipelineStatus{
			Phase: core.PhasePending,
		}
	}

	// 3. Resolve agent roles referenced in stages
	agentNames := GatherAgentNames(pipeline.Spec.Stages)
	resolvedAgents, err := r.resolveAgentRoles(ctx, pipeline.Namespace, agentNames)
	if err != nil {
		return r.setConditionAndRequeue(ctx, &pipeline, "AgentsResolved", "False",
			"ResolutionFailed", err.Error())
	}

	// 4. Resolve quality gates referenced in stages
	gateNames := GatherQualityGateNames(pipeline.Spec.Stages)
	resolvedGates, err := r.resolveQualityGates(ctx, pipeline.Namespace, gateNames)
	if err != nil {
		return r.setConditionAndRequeue(ctx, &pipeline, "GatesResolved", "False",
			"ResolutionFailed", err.Error())
	}

	// 5. Set Ready condition based on resolution
	_ = resolvedAgents
	_ = resolvedGates

	return r.setConditionAndRequeue(ctx, &pipeline, "Ready", "True",
		"Reconciled", fmt.Sprintf("Resolved %d agents and %d gates",
			len(resolvedAgents), len(resolvedGates)))
}

// resolveAgentRoles fetches all AgentRoleResource objects referenced by pipeline stages.
func (r *PipelineReconciler) resolveAgentRoles(
	ctx context.Context,
	namespace string,
	names []string,
) (map[string]*aisdlcv1alpha1.AgentRoleResource, error) {
	resolved := make(map[string]*aisdlcv1alpha1.AgentRoleResource, len(names))
	for _, name := range names {
		var agent aisdlcv1alpha1.AgentRoleResource
		key := client.ObjectKey{Namespace: namespace, Name: name}
		if err := r.Get(ctx, key, &agent); err != nil {
			if errors.IsNotFound(err) {
				return nil, fmt.Errorf("agent role %q not found", name)
			}
			return nil, fmt.Errorf("fetching agent role %q: %w", name, err)
		}
		resolved[name] = &agent
	}
	return resolved, nil
}

// resolveQualityGates fetches all QualityGateResource objects referenced by pipeline stages.
func (r *PipelineReconciler) resolveQualityGates(
	ctx context.Context,
	namespace string,
	names []string,
) (map[string]*aisdlcv1alpha1.QualityGateResource, error) {
	resolved := make(map[string]*aisdlcv1alpha1.QualityGateResource, len(names))
	for _, name := range names {
		var gate aisdlcv1alpha1.QualityGateResource
		key := client.ObjectKey{Namespace: namespace, Name: name}
		if err := r.Get(ctx, key, &gate); err != nil {
			if errors.IsNotFound(err) {
				return nil, fmt.Errorf("quality gate %q not found", name)
			}
			return nil, fmt.Errorf("fetching quality gate %q: %w", name, err)
		}
		resolved[name] = &gate
	}
	return resolved, nil
}

// setConditionAndRequeue updates a condition on the pipeline status and requeues.
func (r *PipelineReconciler) setConditionAndRequeue(
	ctx context.Context,
	pipeline *aisdlcv1alpha1.PipelineResource,
	condType, status, reason, message string,
) (ctrl.Result, error) {
	now := metav1.Now().Format(time.RFC3339)

	found := false
	for i, c := range pipeline.Status.Conditions {
		if c.Type == condType {
			pipeline.Status.Conditions[i].Status = core.ConditionStatus(status)
			pipeline.Status.Conditions[i].Reason = reason
			pipeline.Status.Conditions[i].Message = message
			pipeline.Status.Conditions[i].LastTransitionTime = now
			found = true
			break
		}
	}
	if !found {
		pipeline.Status.Conditions = append(pipeline.Status.Conditions, core.Condition{
			Type:               condType,
			Status:             core.ConditionStatus(status),
			Reason:             reason,
			Message:            message,
			LastTransitionTime: now,
		})
	}

	if err := r.Status().Update(ctx, pipeline); err != nil {
		return ctrl.Result{}, fmt.Errorf("updating pipeline status: %w", err)
	}

	if status == "False" {
		return ctrl.Result{RequeueAfter: 30 * time.Second}, nil
	}
	return ctrl.Result{}, nil
}

// SetupWithManager registers the PipelineReconciler with the controller manager.
func (r *PipelineReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&aisdlcv1alpha1.PipelineResource{}).
		Complete(r)
}

// ── Helpers ─────────────────────────────────────────────────────────

// GatherAgentNames extracts unique agent names from pipeline stages.
func GatherAgentNames(stages []core.Stage) []string {
	seen := make(map[string]struct{})
	var names []string
	for _, s := range stages {
		if s.Agent != "" {
			if _, ok := seen[s.Agent]; !ok {
				seen[s.Agent] = struct{}{}
				names = append(names, s.Agent)
			}
		}
	}
	return names
}

// GatherQualityGateNames extracts unique quality gate names from pipeline stages.
func GatherQualityGateNames(stages []core.Stage) []string {
	seen := make(map[string]struct{})
	var names []string
	for _, s := range stages {
		for _, qg := range s.QualityGates {
			if _, ok := seen[qg]; !ok {
				seen[qg] = struct{}{}
				names = append(names, qg)
			}
		}
	}
	return names
}
