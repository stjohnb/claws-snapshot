> Copy to docs/postmortems/YYYY-MM-DD-<slug>.md in the affected repo and fill in. Process: St-John-Software/claws docs/postmortem-process.md

# Postmortem: <short description>

- **Date:** <YYYY-MM-DD>
- **Author:** <name or session>
- **Status:** <draft/final>
- **Severity:** <sev level or plain description of blast radius>
- **Incident issue:** <link>

## Summary

<what broke, in one sentence. blast radius, in one sentence. resolution, in one sentence. three sentences max.>

## Impact

<who/what was affected, and for how long>

## Timeline

| Time (UTC) | Event | Source |
| --- | --- | --- |
| <timestamp or `unknown`> | Change landed | <link/command that established this> |
| <timestamp or `unknown`> | Defect became live | <source> |
| <timestamp or `unknown`> | First symptom | <source> |
| <timestamp or `unknown`> | Detected | <source> |
| <timestamp or `unknown`> | Mitigated | <source> |
| <timestamp or `unknown`> | Resolved | <source> |

## Metrics

> If the incident is unresolved at write time, set Status: draft above, write `pending (#N)` for the not-yet-known rows, and finalize per Phase 7 when the fix lands.

- **Time to detect:** <duration, derived from timeline>
- **Time to mitigate:** <duration derived from timeline, or `pending (#N)` if the fix is not yet landed>
- **Time to resolve:** <duration derived from timeline, or `pending (#N)` if the fix is not yet landed>

## Contributing factors

1. <blameless paragraph — what was true, why it wasn't caught, no names>
2. <blameless paragraph>
3. <blameless paragraph>

## Detection ladder

| Rung | Would it have caught this? | Why / why not | Change that would make it catch this |
| --- | --- | --- | --- |
| 1. Design / issue refinement | <yes/no> | <why/why not> | <change, or "n/a — already would catch this"> |
| 2. Human PR review | <yes/no> | <why/why not> | <change> |
| 3. Automated pre-merge checks | <yes/no> | <why/why not — did the guarding check actually trigger for this change?> | <change> |
| 4. Merge gate | <yes/no> | <why/why not> | <change> |
| 5. Deploy-time verification | <yes/no> | <why/why not> | <change> |
| 6. Runtime monitoring / alerting | <yes/no> | <why/why not> | <change> |
| 7. User report | <yes/no> | <why/why not> | <change> |

**Shift-left target:** <rung>

## What went well

<what worked correctly during detection, mitigation, or resolution>

## Action items

| # | Action | Class (prevent/detect/mitigate) | Issue | Status |
| --- | --- | --- | --- | --- |
| 1 | <action> | <class> | <issue link/number> | <status> |

## Considered and rejected

| Action | Why not |
| --- | --- |
| <action> | <reason> |
