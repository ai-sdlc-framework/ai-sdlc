# Community Adapters

Community-contributed adapters for the AI-SDLC Framework.

## Available Adapters

| Adapter | Interface | Status |
| --- | --- | --- |
| [Jira](adapters/jira/) | IssueTracker | Planned |
| [GitLab](adapters/gitlab/) | SourceControl, CIPipeline | Planned |
| [Bitbucket](adapters/bitbucket/) | SourceControl | Planned |
| [SonarQube](adapters/sonarqube/) | CodeAnalysis | Planned |
| [Semgrep](adapters/semgrep/) | CodeAnalysis | Planned |

## Creating an Adapter

1. Create a directory under `adapters/` with your adapter name
2. Add a `metadata.yaml` following the [adapter registration spec](../spec/adapters.md#3-adapter-registration)
3. Implement the required [interface contracts](../spec/adapters.md#2-interface-contracts)
4. Submit a PR — see [CONTRIBUTING.md](../CONTRIBUTING.md)

## Distribution Builder

Use the `builder-manifest.yaml` to assemble custom distributions with only the adapters you need. See the [distribution builder spec](../spec/adapters.md#6-custom-distribution-builder).

## License

Apache-2.0
