# Security notes

Run this tool from a trusted, protected worker branch. The pipeline token, model key, and state key must never be exposed to contributor-controlled code or PR build jobs.

Use a dedicated Azure service identity. Configure the required status policy's Authorized identity, reset-on-change, and apply-by-default settings. Require the Azure environment Exclusive lock check to prevent concurrent state updates.

Only encrypted, authenticated state authored by the configured service identity is trusted. Answers are accepted only from the PR author's Azure DevOps identity. Maintainers with policy-bypass, comment-administration, or worker-secret privileges remain trusted administrators.

Source contents are sent to the configured model provider. No model tools or code execution are enabled. The worker never executes application code. AI questions may be misleading or wrong; passing is not a security or code-quality guarantee.

Report vulnerabilities privately to this repository's owner. Do not include tokens, PR source, or encryption keys in public issues.
