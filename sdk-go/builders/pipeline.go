// Package builders provides fluent builder APIs for AI-SDLC resource types.
package builders

import (
	"fmt"

	"github.com/ai-sdlc-framework/ai-sdlc/sdk-go/core"
)

// PipelineBuilder constructs a Pipeline resource via method chaining.
type PipelineBuilder struct {
	name      string
	namespace string
	labels    map[string]string
	triggers  []core.Trigger
	providers map[string]core.Provider
	stages    []core.Stage
	routing   *core.RoutingConfig
	branching *core.BranchingConfig
	pr        *core.PullRequestConfig
	notifs    *core.NotificationsConfig
}

// NewPipelineBuilder creates a new PipelineBuilder with the given name.
func NewPipelineBuilder(name string) *PipelineBuilder {
	return &PipelineBuilder{
		name:      name,
		labels:    make(map[string]string),
		providers: make(map[string]core.Provider),
	}
}

func (b *PipelineBuilder) Namespace(ns string) *PipelineBuilder {
	b.namespace = ns
	return b
}

func (b *PipelineBuilder) Label(key, value string) *PipelineBuilder {
	b.labels[key] = value
	return b
}

func (b *PipelineBuilder) AddTrigger(event string, filter *core.TriggerFilter) *PipelineBuilder {
	b.triggers = append(b.triggers, core.Trigger{Event: event, Filter: filter})
	return b
}

func (b *PipelineBuilder) AddProvider(name, adapterType string, config map[string]interface{}) *PipelineBuilder {
	b.providers[name] = core.Provider{Type: adapterType, Config: config}
	return b
}

func (b *PipelineBuilder) AddStage(name, agent string, opts *StageOptions) *PipelineBuilder {
	stage := core.Stage{Name: name, Agent: agent}
	if opts != nil {
		stage.QualityGates = opts.QualityGates
		stage.OnFailure = opts.OnFailure
		stage.Timeout = opts.Timeout
		stage.Credentials = opts.Credentials
		stage.Approval = opts.Approval
	}
	b.stages = append(b.stages, stage)
	return b
}

func (b *PipelineBuilder) WithRouting(routing *core.RoutingConfig) *PipelineBuilder {
	b.routing = routing
	return b
}

func (b *PipelineBuilder) WithBranching(branching *core.BranchingConfig) *PipelineBuilder {
	b.branching = branching
	return b
}

func (b *PipelineBuilder) WithPullRequest(pr *core.PullRequestConfig) *PipelineBuilder {
	b.pr = pr
	return b
}

func (b *PipelineBuilder) WithNotifications(notifs *core.NotificationsConfig) *PipelineBuilder {
	b.notifs = notifs
	return b
}

// Build validates and returns the Pipeline resource.
func (b *PipelineBuilder) Build() (*core.Pipeline, error) {
	if b.name == "" {
		return nil, fmt.Errorf("pipeline name is required")
	}
	if len(b.triggers) == 0 {
		return nil, fmt.Errorf("at least one trigger is required")
	}
	if len(b.stages) == 0 {
		return nil, fmt.Errorf("at least one stage is required")
	}

	p := &core.Pipeline{
		APIVersion: core.APIVersion,
		Kind:       string(core.KindPipeline),
		Metadata: core.Metadata{
			Name:      b.name,
			Namespace: b.namespace,
		},
		Spec: core.PipelineSpec{
			Triggers:      b.triggers,
			Providers:     b.providers,
			Stages:        b.stages,
			Routing:       b.routing,
			Branching:     b.branching,
			PullRequest:   b.pr,
			Notifications: b.notifs,
		},
	}
	if len(b.labels) > 0 {
		p.Metadata.Labels = b.labels
	}
	return p, nil
}

// StageOptions provides optional configuration for a pipeline stage.
type StageOptions struct {
	QualityGates []string
	OnFailure    *core.FailurePolicy
	Timeout      string
	Credentials  *core.CredentialPolicy
	Approval     *core.ApprovalPolicy
}
