# AI-SDLC Framework Governance

This document describes the governance model for the AI-SDLC Framework specification project.

## Roles

### Maintainer

Maintainers have write access to the repository and are responsible for the overall direction of the specification. Maintainers:

- Review and approve pull requests (2 maintainer approvals required for normative changes)
- Manage the RFC process and ensure proposals receive timely review
- Triage issues and assign reviewers
- Represent the project in external forums and standards bodies
- Vote on governance decisions

Maintainers are added by unanimous consent of existing maintainers, based on sustained, high-quality contributions over a period of at least 6 months.

### Reviewer

Reviewers have demonstrated expertise in one or more areas of the specification. Reviewers:

- Provide detailed technical review on pull requests within their area of expertise
- Participate in RFC discussions and working group reviews
- Are listed as suggested reviewers for PRs touching their area

Reviewers are nominated by any maintainer and confirmed by majority vote of maintainers.

### Contributor

Anyone who submits a pull request, opens an issue, participates in discussions, or contributes to the RFC process. All contributors must follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Decision Making

### Lazy Consensus

The project uses lazy consensus for most decisions:

1. A proposal is made (via PR, issue, or RFC)
2. A reasonable period for feedback is provided (7 days for normative changes, 3 days for editorial)
3. If no objections are raised, the proposal is accepted
4. Silence is interpreted as consent

### Formal Vote

Formal votes are required for:

- Changes to this governance document
- Adding or removing maintainers
- Resolving disputes where lazy consensus fails
- Major architectural decisions affecting the specification direction

Formal votes require:
- Quorum: majority of maintainers participating
- Approval: two-thirds of participating maintainers

### Dispute Resolution

1. Discussion in the relevant PR or issue
2. Escalation to the relevant SIG meeting
3. Formal vote among maintainers
4. If still unresolved, appeal to the project charter

## Special Interest Groups (SIGs)

SIGs are standing working groups that own specific areas of the specification.

### sig-spec

- **Scope**: Core specification (`spec.md`), resource model, schema definitions, versioning
- **Meeting cadence**: Bi-weekly
- **Responsibilities**: Review RFCs affecting core resource types, maintain JSON schemas, define conformance levels

### sig-adapters

- **Scope**: Adapter layer (`adapters.md`), interface contracts, adapter registry, distribution builder
- **Meeting cadence**: Bi-weekly
- **Responsibilities**: Define and evolve adapter interface contracts, review adapter implementations for conformance, maintain adapter registration process

### sig-security

- **Scope**: Security aspects across all spec documents, autonomy system, policy enforcement
- **Meeting cadence**: Monthly
- **Responsibilities**: Review security implications of spec changes, maintain autonomy level definitions, ensure alignment with CSA ATF and OWASP ASI, advise on enterprise readiness requirements

### sig-sdk

- **Scope**: Language-specific SDKs (`sdk-typescript/`, `sdk-python/`, `sdk-go/`), reference implementation (`reference/`), developer experience
- **Meeting cadence**: Bi-weekly
- **Responsibilities**: Maintain SDK packages, keep SDKs in sync with specification, ensure consistent developer experience across languages, maintain the reference implementation

See [`community/sigs/`](community/sigs/) for detailed SIG charters.

## Meetings

- SIG meetings are open to all contributors
- Agendas are posted at least 24 hours in advance
- Meeting notes are published in [`community/meetings/`](community/meetings/) within 48 hours
- Decisions made in meetings must be ratified via the normal PR/RFC process

## Amendments

Changes to this governance document require:

1. An RFC describing the proposed change
2. A 14-day comment period
3. A formal vote with two-thirds majority of maintainers
