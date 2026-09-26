# Claws product requirements

**Entry point.** Read this first when planning a feature or bug fix. It states what
Claws must achieve and why; choose the relevant area below before reading
implementation documentation.

Claws is a self-hosted automation service for repositories managed by St-John-Software.
It turns repository signals into safely supervised planning, implementation, review,
operations, and interactive-agent workflows for an operator who remains in control.

## Goals

- Make routine repository work observable, reliable, and safe to supervise.
- Preserve human approval for consequential changes while reducing avoidable manual work.
- Give interactive agents the context and least privilege needed to make evidence-based progress.

## Non-goals

- Replace the operator's judgement for approvals, secrets, or destructive operations.
- Treat an implementation detail or an obsolete host as a product commitment.

## Areas

| Area | Read this when | Doc |
|---|---|---|
| Automation lifecycle | Changing issue, plan, PR, review, or repository onboarding behaviour. | [Automation lifecycle](product/automation-lifecycle.md) |
| Interactive sessions | Changing sessions, agent access, terminal UX, or session usage. | [Interactive sessions](product/interactive-sessions.md) |
| Operations and safety | Changing alerts, deployments, monitoring, storage, or secret handling. | [Operations and safety](product/operations-and-safety.md) |
| Dashboard and integrations | Changing an operator-facing page or a supported external integration. | [Dashboard and integrations](product/dashboard-and-integrations.md) |

## Cross-cutting constraints

- All repository changes land through pull requests; direct default-branch pushes are never an automation shortcut.
- Managed repositories opt in from their own repository configuration rather than hidden host-only per-repository state.
- Cross-repository inspection and companion issue filing may be available by default; changing another repository still requires its own pull request.
- Product requirements describe outcomes and rationale, not internal module layout.
