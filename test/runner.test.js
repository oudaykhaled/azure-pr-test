import test from 'node:test';
import assert from 'node:assert/strict';
import { processPR, run } from '../src/runner.js';
import { unseal } from '../src/state.js';

const config = { orgUrl: 'https://dev.azure.com/org', project: 'project', repository: 'repo',
  botId: 'bot', stateKey: 'a'.repeat(64), maxAttempts: 3 };
const quiz = { questions: [{ question: 'What happens?', choices: { A: 'Throws', B: 'Retries', C: 'Stops', D: 'Deletes' }, answer: 'B', evidencePath: '/src/app.js' }] };

function fixture() {
  const pr = { pullRequestId: 1, status: 'active', createdBy: { id: 'author' } };
  const iteration = { id: 1, sourceRefCommit: { commitId: 'source' }, targetRefCommit: { commitId: 'target' }, commonRefCommit: { commitId: 'base' } };
  const threads = [];
  const statuses = [];
  const client = {
    pr: async () => structuredClone(pr), iteration: async () => structuredClone(iteration),
    threads: async () => structuredClone(threads), context: async () => ({ files: [] }),
    activePRs: async () => [pr], status: async (...args) => statuses.push(args),
    createThread: async (_id, content) => {
      threads.push({ id: threads.length + 1, comments: [{ id: 1, content, author: { id: 'bot' }, publishedDate: new Date().toISOString() }] });
    },
    updateComment: async (_id, threadId, commentId, content) => {
      threads.find(t => t.id === threadId).comments.find(c => c.id === commentId).content = content;
    },
  };
  const state = () => unseal(threads[0].comments[0].content, config.stateKey);
  const answer = (value = 'B', author = 'author', id) => {
    const thread = { id: id || threads.length + 1, comments: [{ id: 1, author: { id: author },
      publishedDate: new Date(Date.now() + 1000).toISOString(), content: `/buut answer ${state().quizId}\n1: ${value}` }] };
    threads.push(thread);
    return thread.comments[0];
  };
  return { client, pr, iteration, threads, statuses, state, answer };
}

async function create(f) { return processPR(f.client, config, 1, async () => structuredClone(quiz)); }

test('creates quiz once and stays pending until answered', async () => {
  const f = fixture();
  assert.equal((await create(f)).result, 'pending');
  assert.equal((await create(f)).result, 'pending');
  assert.equal(f.threads.length, 1);
  assert.equal(f.state().questions[0].answer, 'B');
  assert.equal(f.threads[0].comments[0].content.includes('"answer":"B"'), false);
});

test('correct author answer succeeds and repeated polling is idempotent', async () => {
  const f = fixture(); await create(f); f.answer();
  assert.equal((await create(f)).result, 'succeeded');
  assert.equal((await create(f)).result, 'succeeded');
  assert.equal(f.state().attempts.length, 1);
});

test('wrong author cannot pass or consume attempts', async () => {
  const f = fixture(); await create(f); f.answer('B', 'attacker');
  assert.equal((await create(f)).result, 'pending');
  assert.equal(f.state().attempts.length, 0);
});

test('edited graded comment cannot create a new attempt or turn failure into success', async () => {
  const f = fixture(); await create(f); const comment = f.answer('A'); await create(f);
  comment.content = comment.content.replace('1: A', '1: B');
  assert.equal((await create(f)).result, 'pending');
  assert.equal(f.state().attempts.length, 1);
  f.answer('B');
  assert.equal((await create(f)).result, 'succeeded');
});

test('attempt limit fails check and prevents additional answers', async () => {
  const f = fixture(); await create(f);
  for (let i = 0; i < 3; i++) { f.answer('A'); await create(f); }
  assert.equal(f.statuses.at(-1)[2], 'failed');
  f.answer('B'); assert.equal((await create(f)).result, 'failed');
  assert.equal(f.state().attempts.length, 3);
});

test('new source revision creates fresh quiz and clears previous pass', async () => {
  const f = fixture(); await create(f); f.answer(); await create(f);
  const oldId = f.state().quizId;
  f.iteration.id = 2; f.iteration.sourceRefCommit.commitId = 'new';
  assert.equal((await create(f)).result, 'pending');
  const nextState = unseal(f.threads.at(-1).comments[0].content, config.stateKey);
  assert.notEqual(nextState.quizId, oldId);
  assert.equal(nextState.passed, false);
});

test('changing PR revision while grading never posts success', async () => {
  const f = fixture(); await create(f); f.answer();
  const original = f.client.updateComment;
  f.client.updateComment = async (...args) => { await original(...args); f.iteration.sourceRefCommit.commitId = 'new'; };
  const count = f.statuses.length;
  assert.equal((await create(f)).result, 'stale');
  assert.equal(f.statuses.slice(count).some(s => s[2] === 'succeeded'), false);
});

test('changing revision during generation discards generated quiz', async () => {
  const f = fixture();
  const outcome = await processPR(f.client, config, 1, async () => { f.iteration.id = 2; return quiz; });
  assert.equal(outcome.result, 'stale');
  assert.equal(f.threads.length, 0);
});

test('model failure reports error and never succeeds', async () => {
  const f = fixture();
  await assert.rejects(processPR(f.client, config, 1, async () => { throw new Error('provider unavailable'); }), /unavailable/);
  assert.equal(f.statuses.at(-1)[2], 'error');
});

test('drafts and completed PRs are skipped', async () => {
  const f = fixture(); f.pr.isDraft = true;
  assert.equal((await create(f)).result, 'skipped');
  assert.equal(f.statuses.length, 0);
  f.pr.isDraft = false; f.pr.status = 'completed';
  assert.equal((await create(f)).result, 'skipped');
});

test('service identity cannot answer its own PR', async () => {
  const f = fixture(); f.pr.createdBy.id = 'bot';
  await assert.rejects(create(f), /separate/);
});

test('run continues other PRs after an operational failure', async () => {
  const f = fixture(); f.client.activePRs = async () => [{ pullRequestId: 1 }, { pullRequestId: 2 }];
  f.client.pr = async id => { if (id === 1) throw new Error('unavailable'); return { ...f.pr, pullRequestId: id }; };
  const logs = [];
  const result = await run(f.client, config, async () => quiz, x => logs.push(x));
  assert.deepEqual(result, { total: 2, failures: 1 });
  assert.ok(logs.some(x => x.includes('PR 2: pending')));
});

test('a forged author comment with copied encrypted state cannot pass', async () => {
  const f = fixture(); await create(f);
  f.threads.push({ id: 2, comments: [{ id: 1, author: { id: 'author' }, content: f.threads[0].comments[0].content }] });
  assert.equal((await create(f)).result, 'pending');
  assert.equal(f.state().attempts.length, 0);
});

test('retargeting a PR invalidates an earlier pass', async () => {
  const f = fixture(); f.pr.targetRefName = 'refs/heads/main'; await create(f); f.answer(); await create(f);
  f.pr.targetRefName = 'refs/heads/release';
  assert.equal((await create(f)).result, 'pending');
});

test('corrupted bot state blocks instead of resetting attempts', async () => {
  const f = fixture(); await create(f);
  f.threads[0].comments[0].content = f.threads[0].comments[0].content.replace(/v1:./, 'v1:z');
  await assert.rejects(create(f), /decrypt/);
  assert.equal(f.statuses.at(-1)[2], 'error');
  assert.equal(f.threads.length, 1);
});
