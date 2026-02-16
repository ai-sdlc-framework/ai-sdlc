package security

import (
	"context"
	"fmt"
)

// ShellExec is a function type for executing shell commands.
type ShellExec func(ctx context.Context, command string, args []string) (stdout, stderr string, exitCode int, err error)

// DockerSandbox executes commands in a Docker container.
type DockerSandbox struct {
	image     string
	shellExec ShellExec
}

// NewDockerSandbox creates a sandbox using Docker.
func NewDockerSandbox(image string, exec ShellExec) *DockerSandbox {
	return &DockerSandbox{image: image, shellExec: exec}
}

func (s *DockerSandbox) Execute(ctx context.Context, command string, args []string) (*SandboxResult, error) {
	dockerArgs := []string{"run", "--rm", "--network=none", s.image, command}
	dockerArgs = append(dockerArgs, args...)

	stdout, stderr, exitCode, err := s.shellExec(ctx, "docker", dockerArgs)
	if err != nil {
		return nil, fmt.Errorf("docker sandbox execution failed: %w", err)
	}
	return &SandboxResult{ExitCode: exitCode, Stdout: stdout, Stderr: stderr}, nil
}

func (s *DockerSandbox) Cleanup(ctx context.Context) error {
	return nil
}
