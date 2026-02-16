package agents

import (
	"context"
	"testing"

	"github.com/ai-sdlc-framework/ai-sdlc/sdk-go/core"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestSequentialOrchestration(t *testing.T) {
	plan := Sequential(
		OrchestrationStep{Name: "step1", Agent: "coder"},
		OrchestrationStep{Name: "step2", Agent: "reviewer"},
	)

	executor := func(ctx context.Context, step *OrchestrationStep) (*StepResult, error) {
		return &StepResult{StepName: step.Name, Succeeded: true}, nil
	}

	result, err := ExecuteOrchestration(context.Background(), plan, executor)
	require.NoError(t, err)
	assert.True(t, result.Succeeded)
	assert.Len(t, result.Steps, 2)
}

func TestParallelOrchestration(t *testing.T) {
	plan := Parallel(
		OrchestrationStep{Name: "lint", Agent: "linter"},
		OrchestrationStep{Name: "test", Agent: "tester"},
	)

	executor := func(ctx context.Context, step *OrchestrationStep) (*StepResult, error) {
		return &StepResult{StepName: step.Name, Succeeded: true}, nil
	}

	result, err := ExecuteOrchestration(context.Background(), plan, executor)
	require.NoError(t, err)
	assert.True(t, result.Succeeded)
	assert.Len(t, result.Steps, 2)
}

func TestHybridOrchestration(t *testing.T) {
	plan := Hybrid(
		OrchestrationStep{Name: "build", Agent: "builder"},
		OrchestrationStep{Name: "test", Agent: "tester", DependsOn: []string{"build"}},
		OrchestrationStep{Name: "deploy", Agent: "deployer", DependsOn: []string{"test"}},
	)

	order := make([]string, 0)
	executor := func(ctx context.Context, step *OrchestrationStep) (*StepResult, error) {
		order = append(order, step.Name)
		return &StepResult{StepName: step.Name, Succeeded: true}, nil
	}

	result, err := ExecuteOrchestration(context.Background(), plan, executor)
	require.NoError(t, err)
	assert.True(t, result.Succeeded)
	assert.Equal(t, []string{"build", "test", "deploy"}, order)
}

func TestSequentialFailure(t *testing.T) {
	plan := Sequential(
		OrchestrationStep{Name: "step1", Agent: "a"},
		OrchestrationStep{Name: "step2", Agent: "b"},
	)

	executor := func(ctx context.Context, step *OrchestrationStep) (*StepResult, error) {
		if step.Name == "step1" {
			return &StepResult{StepName: step.Name, Succeeded: false, Error: "failed"}, nil
		}
		return &StepResult{StepName: step.Name, Succeeded: true}, nil
	}

	result, err := ExecuteOrchestration(context.Background(), plan, executor)
	require.NoError(t, err)
	assert.False(t, result.Succeeded)
	assert.Len(t, result.Steps, 1, "should stop after first failure")
}

func TestAgentDiscovery(t *testing.T) {
	discovery := NewAgentDiscovery()

	agent1 := &core.AgentRole{
		Metadata: core.Metadata{Name: "coder"},
		Spec: core.AgentRoleSpec{
			Role:  "Developer",
			Goal:  "Write code",
			Tools: []string{"git"},
			Skills: []core.Skill{
				{ID: "go-dev", Description: "Go development", Tags: []string{"go", "backend"}},
			},
		},
	}
	agent2 := &core.AgentRole{
		Metadata: core.Metadata{Name: "reviewer"},
		Spec: core.AgentRoleSpec{
			Role:  "Reviewer",
			Goal:  "Review code",
			Tools: []string{"git"},
			Skills: []core.Skill{
				{ID: "code-review", Description: "Code review", Tags: []string{"review"}},
			},
		},
	}

	discovery.Register(agent1)
	discovery.Register(agent2)

	found := discovery.FindBySkill("go-dev")
	assert.Len(t, found, 1)
	assert.Equal(t, "coder", found[0].Metadata.Name)

	found = discovery.FindByTag("review")
	assert.Len(t, found, 1)

	all := discovery.ListAll()
	assert.Len(t, all, 2)
}

func TestMatchAgentBySkill(t *testing.T) {
	agents := []*core.AgentRole{
		{
			Metadata: core.Metadata{Name: "coder"},
			Spec: core.AgentRoleSpec{
				Skills: []core.Skill{{ID: "go-dev", Description: "Go development"}},
			},
		},
	}

	match := MatchAgentBySkill(agents, "go-dev")
	assert.NotNil(t, match)
	assert.Equal(t, "coder", match.Metadata.Name)

	match = MatchAgentBySkill(agents, "python")
	assert.Nil(t, match)
}

func TestValidateHandoff(t *testing.T) {
	err := ValidateHandoff(
		map[string]interface{}{"summary": "task done", "artifacts": []string{"file.go"}},
		[]string{"summary", "artifacts"},
	)
	assert.NoError(t, err)

	err = ValidateHandoff(
		map[string]interface{}{"summary": "task done"},
		[]string{"summary", "artifacts"},
	)
	assert.Error(t, err)
}
