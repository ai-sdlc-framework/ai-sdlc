package agents

import (
	"strings"

	"github.com/ai-sdlc-framework/ai-sdlc/sdk-go/core"
)

// AgentDiscovery finds agents by their capabilities.
type AgentDiscovery interface {
	Register(agent *core.AgentRole) error
	FindBySkill(skillID string) []*core.AgentRole
	FindByTag(tag string) []*core.AgentRole
	ListAll() []*core.AgentRole
}

type agentDiscovery struct {
	agents []*core.AgentRole
}

// NewAgentDiscovery creates a new agent discovery service.
func NewAgentDiscovery() AgentDiscovery {
	return &agentDiscovery{}
}

func (d *agentDiscovery) Register(agent *core.AgentRole) error {
	d.agents = append(d.agents, agent)
	return nil
}

func (d *agentDiscovery) FindBySkill(skillID string) []*core.AgentRole {
	var results []*core.AgentRole
	for _, a := range d.agents {
		for _, s := range a.Spec.Skills {
			if s.ID == skillID {
				results = append(results, a)
				break
			}
		}
	}
	return results
}

func (d *agentDiscovery) FindByTag(tag string) []*core.AgentRole {
	var results []*core.AgentRole
	for _, a := range d.agents {
		for _, s := range a.Spec.Skills {
			for _, t := range s.Tags {
				if t == tag {
					results = append(results, a)
					goto next
				}
			}
		}
	next:
	}
	return results
}

func (d *agentDiscovery) ListAll() []*core.AgentRole {
	result := make([]*core.AgentRole, len(d.agents))
	copy(result, d.agents)
	return result
}

// MatchAgentBySkill finds the best matching agent for a required skill.
func MatchAgentBySkill(agents []*core.AgentRole, requiredSkill string) *core.AgentRole {
	for _, a := range agents {
		for _, s := range a.Spec.Skills {
			if s.ID == requiredSkill {
				return a
			}
		}
	}
	// Fuzzy match on description
	for _, a := range agents {
		for _, s := range a.Spec.Skills {
			if strings.Contains(strings.ToLower(s.Description), strings.ToLower(requiredSkill)) {
				return a
			}
		}
	}
	return nil
}
