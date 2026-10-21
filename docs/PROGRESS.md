# Progress board

Sole writer: root agent. Updated: 2026-10-21.

| Item | Owner | Status | Evidence | Blocker | Next step |
| --- | --- | --- | --- | --- | --- |
| Azure Repos adapter and quiz engine | root | Implemented, locally verified | REST API 7.1 adapter; Azure OpenAI/OpenAI schema validation; local HTTP flow passes | None | Live Azure acceptance after configuration |
| Identity, encrypted state, revision binding | root | Implemented, locally verified | Author-only answers; AES-256-GCM; stale push, retarget, forged state, edited submissions and attempt-limit tests | None | Live Azure acceptance after configuration |
| Azure Pipeline and setup guide | root | Implemented | azure-pipelines.yml; docs/AZURE_SETUP.md; required lock and status-policy setup documented | Azure organization, identity, model deployment and secrets not configured | Follow disposable-PR acceptance procedure |
| Automated verification | root | Passed locally | 62 tests pass on Node 22 and 24, including local HTTP integration; syntax/YAML checks pass; npm audit: 0 vulnerabilities | Live providers/APIs not exercised | No further local checks required |
| Remote repository | root | Created; source push pending | https://github.com/oudaykhaled/buut-pr-test is private | OAuth token cannot publish active GitHub workflows | Keep GitHub CI as inactive example, push source |

Implemented, locally verified, remotely published, and live Azure verified are separate milestones. No application deployment or Azure organization/branch-policy changes have been performed. Tests use fixtures; the local HTTP test exercises actual client requests against a local service, not live Azure/OpenAI.
