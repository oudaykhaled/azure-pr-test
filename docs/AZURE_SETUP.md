# Configure Azure DevOps

## 1. Keep the worker source trusted

Create an Azure Pipeline using `azure-pipelines.yml` from this repository's protected `main` branch. Azure Pipelines can connect to this private GitHub repository using an authorized GitHub connection, or you can import the worker repository into Azure Repos.

Run the worker separately from the application repository's PR builds. It must never check out or execute the PR's code, scripts, YAML, or dependencies. Restrict edits, manual-run branch selection, pipeline administration, secret access, and variable-group authorization to maintainers. In particular, do not attach this YAML as a build-validation policy that executes contributor-controlled PR source.

## 2. Grant the service identity access

The template authenticates to Azure using `System.AccessToken`. On the **target Azure repository**, grant the worker pipeline's build-service identity:

- **Read**, to fetch PRs, iterations, files, and comments.
- **Contribute to pull requests**, to create/edit its own quiz comments and post statuses.

Use the project-scoped build service where possible, and do not grant policy-bypass or repository-write privileges. If the target repository is in a different project, grant the build-service identity the necessary project/repository access explicitly. With **Protect access to repositories in YAML pipelines** enabled, explicitly reference and authorize the target repository as an Azure Pipelines repository resource, or use a dedicated, restricted service identity instead. Do not disable organization-wide access controls to work around a 401/403.

For local use, a dedicated service account PAT needs Code (Read & write) scope and the repository permissions above. Do not use the PR author's personal PAT: the quiz service identity must be distinct from authors.

### Find AZURE_BOT_ID

Find the worker's Azure DevOps identity GUID (not its Microsoft Entra object ID). One practical bootstrap:

1. Run a temporary trusted pipeline step that creates a clearly labelled setup comment in a disposable PR using the worker token and Azure's [Create thread endpoint](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-request-threads/create?view=azure-devops-rest-7.1).
2. Inspect that response's `comments[0].author.id` and use it as `AZURE_BOT_ID`.
3. Remove the bootstrap step and setup comment. Never print the token or full environment.

Alternatively, your Azure administrator can retrieve the build-service Azure DevOps identity GUID using the identities API or administration tools.

## 3. Configure the variable group

Create a variable group named **buut-pr-test** and authorize only the trusted worker pipeline to use it.

| Variable | Value | Secret? |
| --- | --- | --- |
| `AZURE_ORG_URL` | `https://dev.azure.com/your-organization` | No |
| `AZURE_PROJECT` | Target project | No |
| `AZURE_REPOSITORY_ID` | Target repository GUID | No |
| `AZURE_BOT_ID` | Worker identity GUID from step 2 | No |
| `QUIZ_STATE_KEY` | 32 random bytes encoded as 64 hex characters | **Yes** |
| `AZURE_OPENAI_ENDPOINT` | Azure OpenAI resource endpoint | No |
| `AZURE_OPENAI_API_KEY` | Resource API key | **Yes** |
| `AZURE_OPENAI_DEPLOYMENT` | A deployment supporting strict structured JSON output | No |

The token is mapped directly from `System.AccessToken`; do not add a static token to the template. It calls Azure DevOps, not Microsoft Graph. The model uses API-key authentication; managed-identity authentication to the model is not implemented in this release.

For public OpenAI, change the step's `LLM_PROVIDER` to `openai` and map `OPENAI_API_KEY` from a secret variable. Remove the Azure OpenAI mappings for clarity. No Azure OpenAI key is required in that mode.

## 4. Serialize runs

In Azure Pipelines → Environments, create **buut-pr-test** (empty environment). Under its checks, add **Exclusive lock** and authorize only this pipeline. The YAML uses `lockBehavior: sequential`.

This lock is necessary because encrypted attempts are updated in Azure comments. The YAML keyword alone does not create the lock check. All pipelines targeting the same repository must share the environment, and local workers must not run alongside them.

Add a branch-control check allowing only the protected worker `main` branch to consume the environment. This check plus restricted pipeline/variable-group access prevents someone from running a modified worker branch with the service secrets.

Reference: [Azure exclusive lock checks](https://learn.microsoft.com/en-us/azure/devops/pipelines/process/approvals?view=azure-devops#exclusive-lock).

## 5. Run the worker, then configure the status policy

Run the trusted pipeline manually on `main`. A non-draft PR in the target repository should receive a quiz and the `buut/pr-test` pending status.

On each protected target branch, open **Branch policies → Status checks**, then configure:

- Status: **buut/pr-test** (genre `buut`, name `pr-test`).
- Policy requirement: **Required**, once the pilot is accepted. Use Optional during initial evaluation.
- Authorized identity: **the worker build-service identity only**. This prevents another contributor posting a forged successful status.
- Reset status whenever there are new changes: **enabled**.
- Policy applicability: **Apply by default**. A new PR must wait even before the first worker scan.
- Restrict bypass permissions to your established maintainers. Keep normal reviewer/build policies.

The worker posts revision-specific status using the Azure iteration ID and rechecks the PR revision before reporting success. Reset-on-change policy closes the window between a source push and the next scan.

Reference: [Configure a policy for an external service](https://learn.microsoft.com/en-us/azure/devops/repos/git/pr-status-policy?view=azure-devops).

## 6. Live acceptance on a disposable PR

Run these checks before requiring the policy on a shared production branch:

1. Open a small, non-draft PR containing a text-code change. Run the worker. Confirm a quiz appears and the check is pending.
2. Submit a complete but wrong answer as the PR author. Run the worker. Confirm pending and one used attempt.
3. Submit the correct form as another person. Run the worker. Confirm it consumes no attempt and does not pass.
4. Submit correct answers as the PR author in a new comment. Run the worker. Confirm succeeded.
5. Push a real source change. Confirm Azure immediately resets the required check. Run the worker and confirm a new quiz ID with zero attempts. The old answer form must not pass.
6. Verify policy Authorized identity is the worker only and that unprivileged contributors cannot edit/delete worker comments or access its secrets.
7. Verify missing provider access or unsupported content produces an operational error, leaving completion blocked. Restore access and confirm recovery.
8. Queue two worker runs and confirm Azure serializes them using the Exclusive lock check.

## Scheduling and costs

The worker polls every 30 minutes, with `always: true`, even when its own source has not changed. A human can request an earlier trusted manual run after posting answers. Model generation happens once per quiz revision, not on every poll. Each scan still uses Azure API calls and pipeline agent time.

Thirty-minute polling is 336 scheduled runs per week, below Azure's documented approximate 1,000 scheduled runs per pipeline per week. Do not switch to continuous five-minute polling (2,016 per week) on this template. For immediate comment-driven grading, a separately authenticated webhook-to-pipeline integration is future work.

References: [Scheduled trigger limits](https://learn.microsoft.com/en-us/azure/devops/pipelines/process/scheduled-triggers?view=azure-devops#limits-on-the-number-of-scheduled-runs-in-yaml-pipelines), [Azure PR service hooks](https://learn.microsoft.com/en-us/azure/devops/service-hooks/events?view=azure-devops).

## Troubleshooting

| Symptom | Resolution |
| --- | --- |
| HTTP 401/403 | Check token type, job authorization scope, target repository authorization, and service-identity permissions. Do not print secrets. |
| Quiz repeats each run | Confirm `AZURE_BOT_ID` matches the actual Azure identity that authors the worker's comments. |
| Waiting after answers | Run the worker on trusted `main`, or wait for the next 30-minute poll; post a complete new form with the current quiz ID. |
| Cannot decrypt quiz | Restore the stable state key. After deliberate key rotation, have a maintainer remove obsolete bot quiz threads and regenerate. |
| Attempt limit reached | Review code and question quality with a maintainer. There is no automatic override command. |
| Unsupported file/context limit | Split the PR or explicitly exclude approved non-code path prefixes. Excluded paths are not assessed. |
| Provider HTTP 400 | Confirm deployment supports structured outputs and `max_completion_tokens`, and that its API version is supported. |
| Schedule does not run | Check the pipeline's default branch is `main`, YAML exists there, and UI schedules are not overriding YAML schedules. |
