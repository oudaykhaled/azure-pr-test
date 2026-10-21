# buut-pr-test

AI-generated PR comprehension quizzes for **Azure DevOps Services / Azure Repos**. The PR author answers in Azure PR comments. A custom `buut/pr-test` status can block completion until the author passes for the current revision.

This is an Azure implementation of the workflow discussed in [GitGud](https://github.com/zesthq/gitgud), written independently. It does not require GitHub Actions, a public tunnel, or a hosted quiz website to operate. GitHub hosts this repository; the operational integration runs in Azure Pipelines.

## How it works

1. A trusted Azure Pipeline scans active, non-draft PRs in a configured Azure repository.
2. It reads every included changed text file at the PR's merge base and source commit, then asks Azure OpenAI (or public OpenAI) for three multiple-choice questions.
3. The service posts a quiz as a PR comment. Correct answers and grading state are encrypted with AES-256-GCM inside the bot's comment.
4. The author posts a new comment using the supplied form:

   ```text
   /buut answer <quiz-id-from-the-bot>
   1: B
   2: D
   3: A
   ```

5. On the next scheduled or manual run, the pipeline grades answers. All must be correct. By default there are three attempts per revision.
6. The `buut/pr-test` status becomes `succeeded`, `pending`, `failed`, or `error`. New source revisions require a new quiz.

Only the Azure PR author's identity can submit answers. An edited, already graded comment does not create a new attempt. Old answers cannot satisfy a new revision. Normal review and test policies continue to apply independently.

## Azure setup

See [the setup guide](docs/AZURE_SETUP.md) for permissions, secrets, identity lookup, pipeline serialization, and branch policies.

The included [azure-pipelines.yml](azure-pipelines.yml) runs every **30 minutes**, or on demand. It processes every active PR in **one configured repository**. Polling is deliberate: Azure PR comment events do not automatically rerun a validation pipeline. This version has no webhook listener.

The template uses a deployment job only to acquire an Azure environment lock. It does **not** deploy an application. Add an **Exclusive lock** check to the environment and authorize only this trusted pipeline. Never run it from a contributor's PR branch.

## Local use

Requirements: Node.js 22 or newer, Azure DevOps access, and a model deployment supporting structured JSON-schema outputs.

```sh
npm ci --ignore-scripts
npm run verify
cp .env.example .env
# Fill in .env locally. Do not commit it.
node --env-file=.env src/cli.js
```

Set `PR_ID` to process one PR, or omit it to scan the configured repository. Local runs mutate Azure PR comments and statuses; they are not a dry run. Use a dedicated service identity and do not run concurrently with the pipeline.

### Configuration

| Variable | Purpose |
| --- | --- |
| `AZURE_ORG_URL` | `https://dev.azure.com/<organization>`; Azure DevOps Services only |
| `AZURE_PROJECT` | Project name or ID |
| `AZURE_REPOSITORY_ID` | Target Azure repository GUID |
| `AZURE_TOKEN` | Pipeline `System.AccessToken`, or a dedicated user's PAT locally |
| `AZURE_AUTH_TYPE` | `bearer` (default) or `pat` |
| `AZURE_BOT_ID` | **Azure DevOps identity GUID** of the token owner; not an Entra object ID |
| `QUIZ_STATE_KEY` | Persistent, secret 64-hex-character encryption key |
| `LLM_PROVIDER` | `azure-openai` (default) or `openai` |
| `AZURE_OPENAI_ENDPOINT` | Azure OpenAI resource endpoint |
| `AZURE_OPENAI_API_KEY` | Secret Azure OpenAI key |
| `AZURE_OPENAI_DEPLOYMENT` | Deployment supporting structured outputs |
| `AZURE_OPENAI_API_VERSION` | Defaults to `2024-10-21` |
| `OPENAI_API_KEY`, `OPENAI_MODEL` | Public OpenAI alternative; model defaults to `gpt-4.1-mini` |
| `PR_ID` | Optional single PR number |
| `QUIZ_QUESTION_COUNT` | 1–5; default 3 |
| `QUIZ_MAX_ATTEMPTS` | 1–10; default 3 |
| `QUIZ_MAX_FILES` | 1–100; default 30 |
| `QUIZ_MAX_CONTEXT_CHARS` | Context character limit; default 80,000 |
| `QUIZ_EXCLUDE_PREFIXES` | Optional comma-separated, case-sensitive repository path prefixes, e.g. `/assets/` |

Optional settings for Azure Pipelines must also be mapped into the `npm start` step's `env` block. Only the required settings are mapped in the supplied template.

Generate the state key once and keep it stable across runs:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

## Boundaries

- This release quizzes **authors**, not reviewers. Passing does not prove understanding or correctness; people can ask AI for answers, and generated questions can be wrong.
- PR file contents, title, and description are sent to your chosen model provider. Other source files and review discussions are not sent. Confirm your team's model/data policy before enabling it.
- The implementation fetches before/after contents, not just compact diff hunks. Large PRs, unsupported binary files, incomplete file content, and model errors leave the policy unsatisfied. Explicitly excluded paths are outside quiz coverage; a fully excluded PR is not automatically passed.
- Fork PRs, Azure DevOps Server/on-premises, merge queues, instant webhooks, and a browser quiz UI are not implemented.
- The Azure environment's **Exclusive lock** check is required to serialize runs. Do not configure multiple independent workers against the same target repository.
- Retain `QUIZ_STATE_KEY`. Changing it makes existing encrypted quiz state unreadable. After an intentional rotation, a maintainer must remove obsolete bot quiz threads so fresh quizzes can be generated.
- Failed quizzes do not automatically reset after the attempt limit. A maintainer can review the code/question quality, make a real corrective commit, or deliberately remove the bot quiz thread to regenerate. Protect permission to edit/delete other identities' comments and to bypass branch policies.
- No Azure organization was configured or exercised during repository creation. Automated tests use fixtures and a local HTTP service; they do not prove live permissions, provider deployment compatibility, or branch-policy setup. Follow the live acceptance procedure in the setup guide.

## Development

No runtime npm dependencies. Native Node.js `fetch`, crypto, and test runner handle the integration. The inactive example in `examples/github-ci.yml` defines a Node 22/24 CI matrix if you later choose to enable GitHub Actions. The Azure pipeline runs verification before processing PRs.

```sh
npm run verify
```

See [the progress board](docs/PROGRESS.md) for implementation and verification evidence.
