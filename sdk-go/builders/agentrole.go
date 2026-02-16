package builders

import (
	"fmt"

	"github.com/ai-sdlc-framework/ai-sdlc/sdk-go/core"
)

// AgentRoleBuilder constructs an AgentRole resource via method chaining.
type AgentRoleBuilder struct {
	name        string
	namespace   string
	labels      map[string]string
	role        string
	goal        string
	backstory   string
	tools       []string
	constraints *core.Constraints
	handoffs    []core.Handoff
	skills      []core.Skill
	agentCard   *core.AgentCard
}

// NewAgentRoleBuilder creates a new AgentRoleBuilder.
func NewAgentRoleBuilder(name string) *AgentRoleBuilder {
	return &AgentRoleBuilder{
		name:   name,
		labels: make(map[string]string),
	}
}

func (b *AgentRoleBuilder) Namespace(ns string) *AgentRoleBuilder {
	b.namespace = ns
	return b
}

func (b *AgentRoleBuilder) Label(key, value string) *AgentRoleBuilder {
	b.labels[key] = value
	return b
}

func (b *AgentRoleBuilder) Role(role string) *AgentRoleBuilder {
	b.role = role
	return b
}

func (b *AgentRoleBuilder) Goal(goal string) *AgentRoleBuilder {
	b.goal = goal
	return b
}

func (b *AgentRoleBuilder) Backstory(backstory string) *AgentRoleBuilder {
	b.backstory = backstory
	return b
}

func (b *AgentRoleBuilder) AddTool(tool string) *AgentRoleBuilder {
	b.tools = append(b.tools, tool)
	return b
}

func (b *AgentRoleBuilder) WithConstraints(c *core.Constraints) *AgentRoleBuilder {
	b.constraints = c
	return b
}

func (b *AgentRoleBuilder) AddHandoff(target, trigger string, contract *core.HandoffContract) *AgentRoleBuilder {
	b.handoffs = append(b.handoffs, core.Handoff{
		Target:   target,
		Trigger:  trigger,
		Contract: contract,
	})
	return b
}

func (b *AgentRoleBuilder) AddSkill(id, description string, tags []string) *AgentRoleBuilder {
	b.skills = append(b.skills, core.Skill{
		ID:          id,
		Description: description,
		Tags:        tags,
	})
	return b
}

func (b *AgentRoleBuilder) WithAgentCard(card *core.AgentCard) *AgentRoleBuilder {
	b.agentCard = card
	return b
}

// Build validates and returns the AgentRole resource.
func (b *AgentRoleBuilder) Build() (*core.AgentRole, error) {
	if b.name == "" {
		return nil, fmt.Errorf("agent role name is required")
	}
	if b.role == "" {
		return nil, fmt.Errorf("role is required")
	}
	if b.goal == "" {
		return nil, fmt.Errorf("goal is required")
	}
	if len(b.tools) == 0 {
		return nil, fmt.Errorf("at least one tool is required")
	}

	a := &core.AgentRole{
		APIVersion: core.APIVersion,
		Kind:       string(core.KindAgentRole),
		Metadata: core.Metadata{
			Name:      b.name,
			Namespace: b.namespace,
		},
		Spec: core.AgentRoleSpec{
			Role:        b.role,
			Goal:        b.goal,
			Backstory:   b.backstory,
			Tools:       b.tools,
			Constraints: b.constraints,
			Handoffs:    b.handoffs,
			Skills:      b.skills,
			AgentCard:   b.agentCard,
		},
	}
	if len(b.labels) > 0 {
		a.Metadata.Labels = b.labels
	}
	return a, nil
}
