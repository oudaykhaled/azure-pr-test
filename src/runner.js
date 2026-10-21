import { randomUUID } from 'node:crypto';
import { commentsOf, findState, grade, parseAnswers, revisionOf, scopeOf, seal } from './state.js';

function text(value) {
  return String(value).replace(/[\\`*_{}\[\]()#+.!|<>]/g, '\\$&');
}

export function renderQuiz(state, config) {
  const lines = ['## Buut PR comprehension quiz', '',
    `PR author: answer all ${state.questions.length} questions about this revision. All answers must be correct.`,
    'Post a **new PR comment** using the form below. Do not edit a submitted comment to retry.', ''];
  state.questions.forEach((q, index) => {
    lines.push(`### ${index + 1}. ${text(q.question)}`, '', `File: ${text(q.evidencePath)}`, '');
    for (const key of ['A', 'B', 'C', 'D']) lines.push(`- **${key}**: ${text(q.choices[key])}`);
    lines.push('');
  });
  lines.push('```text', `/buut answer ${state.quizId}`,
    ...state.questions.map((_, index) => `${index + 1}: A`), '```', '',
    `The A values are placeholders. Attempts: ${state.attempts.length}/${config.maxAttempts}.`,
    state.passed ? '**Passed for this revision.**' : state.attempts.length >= config.maxAttempts
      ? '**Attempt limit reached. Ask a maintainer to review the change and the quiz; there is no automatic bypass.**'
      : '**Waiting for correct author answers.**');
  const last = state.attempts.at(-1);
  if (last && !last.passed) lines.push('', `Revisit questions: ${last.incorrect.join(', ')}.`);
  lines.push('', 'AI-generated questions can be wrong. This check supplements code review and tests.', '', seal(state, config.stateKey));
  return lines.join('\n');
}

async function currentRevision(client, id) {
  const pr = await client.pr(id);
  const iteration = await client.iteration(id);
  return { pr, iteration, revision: revisionOf(pr, iteration) };
}

export async function processPR(client, config, id, makeQuiz) {
  let iteration;
  try {
    const snapshot = await currentRevision(client, id);
    const { pr, revision } = snapshot;
    iteration = snapshot.iteration;
    if (pr.status !== 'active' || pr.isDraft) return { id, result: 'skipped' };
    if (pr.createdBy.id.toLowerCase() === config.botId) throw new Error('The quiz service identity must be separate from the PR author');
    await client.status(id, iteration.id, 'pending', 'Buut: checking comprehension of the current revision');
    const scope = scopeOf(config, id);
    let comments = commentsOf(await client.threads(id));
    let record = findState(comments, config, scope, revision);
    if (!record) {
      const context = await client.context(pr, iteration);
      const quiz = await makeQuiz(context);
      const fresh = await currentRevision(client, id);
      if (fresh.revision !== revision || fresh.pr.status !== 'active') return { id, result: 'stale' };
      const state = {
        scope, revision, quizId: randomUUID(), authorId: pr.createdBy.id.toLowerCase(),
        createdAt: new Date().toISOString(), questions: quiz.questions, attempts: [], passed: false,
      };
      await client.createThread(id, renderQuiz(state, config));
      comments = commentsOf(await client.threads(id));
      record = findState(comments, config, scope, revision);
      if (!record) throw new Error('Quiz comment not found under AZURE_BOT_ID; verify the service identity');
    }
    const { state, comment } = record;
    const seen = new Set(state.attempts.map(a => a.commentKey));
    const submissions = comments
      .filter(c => c.author?.id?.toLowerCase() === state.authorId && c.content &&
        Date.parse(c.publishedDate) >= Date.parse(state.createdAt))
      .sort((a, b) => Date.parse(a.publishedDate) - Date.parse(b.publishedDate) || a.threadId - b.threadId || a.id - b.id);
    let changed = false;
    for (const submission of submissions) {
      if (state.passed || state.attempts.length >= config.maxAttempts) break;
      const commentKey = `${submission.threadId}:${submission.id}`;
      if (seen.has(commentKey)) continue;
      const answers = parseAnswers(submission.content, state.quizId, state.questions.length);
      if (!answers) continue;
      const result = grade(state.questions, answers);
      state.attempts.push({ commentKey, ...result });
      seen.add(commentKey);
      state.passed = result.passed;
      changed = true;
    }
    if (changed) await client.updateComment(id, comment.threadId, comment.id, renderQuiz(state, config));
    const fresh = await currentRevision(client, id);
    if (fresh.revision !== revision || fresh.pr.status !== 'active') return { id, result: 'stale' };
    const status = state.passed ? 'succeeded' : state.attempts.length >= config.maxAttempts ? 'failed' : 'pending';
    await client.status(id, iteration.id, status, state.passed
      ? 'Buut: PR author passed the current revision quiz'
      : `Buut: waiting for author answers (${state.attempts.length}/${config.maxAttempts} attempts)`);
    return { id, result: status };
  } catch (error) {
    if (iteration) {
      try { await client.status(id, iteration.id, 'error', 'Buut could not evaluate this revision; inspect the trusted pipeline log'); }
      catch { /* Preserve the original error; the required policy must remain unsatisfied. */ }
    }
    throw error;
  }
}

export async function run(client, config, makeQuiz, log = console.log) {
  const prs = config.prId ? [{ pullRequestId: config.prId }] : await client.activePRs();
  let failures = 0;
  for (const pr of prs) {
    try {
      const outcome = await processPR(client, config, pr.pullRequestId, makeQuiz);
      log(`PR ${outcome.id}: ${outcome.result}`);
    } catch (error) {
      failures++;
      log(`PR ${pr.pullRequestId}: ${error.message}`);
    }
  }
  return { total: prs.length, failures };
}
