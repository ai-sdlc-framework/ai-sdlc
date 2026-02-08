# Security Policy

## Supported Versions

| Version   | Supported |
| --------- | --------- |
| v1alpha1  | Yes       |

## Reporting a Vulnerability

If you discover a security vulnerability in this project, please report it responsibly.

**Email:** security@ai-sdlc.io

Please include:

- A description of the vulnerability
- Steps to reproduce the issue
- Any relevant logs or screenshots
- Your assessment of the severity

### Response Timeline

- **48 hours** — Acknowledgment of your report
- **7 days** — Initial assessment and severity classification
- **30 days** — Fix for critical/high severity issues
- **90 days** — Fix for medium/low severity issues

## Scope

The following components are in scope for security reports:

- JSON Schema definitions (`spec/schemas/`)
- Reference implementation (`reference/`)
- TypeScript SDK (`sdk-typescript/`)
- Conformance test runner (`conformance/`)
- CI/CD pipeline configuration (`.github/workflows/`)

### Out of Scope

- Community-contributed adapters (`contrib/`)
- Third-party implementations
- Spec normative text (report spec issues via GitHub Issues)

## Security Notes for Implementors

### Secret Management

All sensitive configuration (API keys, tokens) MUST use `secretRef` indirection
rather than inline values. Implementations SHOULD integrate with a secrets manager
(e.g., Kubernetes Secrets, Vault, cloud-native KMS).

### Autonomy Guardrails

The AutonomyPolicy resource defines progressive trust levels for AI agents.
Implementations MUST enforce `blockedPaths`, `maxLinesPerPR`, and `requireApproval`
constraints at the enforcement layer — not just in the UI.

### Adapter Authentication

AdapterBinding resources that connect to external systems MUST:

- Use `secretRef` for credentials (never inline)
- Validate TLS certificates for all external connections
- Apply principle of least privilege for API scopes
- Log all authentication failures for audit
