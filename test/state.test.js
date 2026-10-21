import test from 'node:test';
import assert from 'node:assert/strict';
import { seal, unseal, parseAnswers, grade, findState, revisionOf, scopeOf } from '../src/state.js';

const key = 'a'.repeat(64);
const state = { scope: 'scope', revision: 'revision', questions: [{ answer: 'B' }] };

test('answer keys are encrypted and authenticated', () => {
  const encrypted = seal(state, key);
  assert.equal(encrypted.includes('"answer"'), false);
  assert.deepEqual(unseal(encrypted, key), state);
  assert.throws(() => unseal(encrypted, 'b'.repeat(64)), /decrypt/);
  const tampered = encrypted.replace(/v1:./, 'v1:z');
  assert.throws(() => unseal(tampered, key), /decrypt/);
});

test('nonce makes identical state encrypt differently', () => {
  assert.notEqual(seal(state, key), seal(state, key));
});

test('ordinary comments have no state', () => assert.equal(unseal('Hello', key), null));

test('only bot-authored state in matching PR scope and revision is trusted', () => {
  const content = seal(state, key);
  const config = { stateKey: key, botId: 'bot' };
  assert.equal(findState([{ content, author: { id: 'attacker' } }], config, 'scope', 'revision'), null);
  assert.equal(findState([{ content, author: { id: 'BOT' } }], config, 'other', 'revision'), null);
  assert.equal(findState([{ content, author: { id: 'bot' } }], config, 'scope', 'new'), null);
  assert.deepEqual(findState([{ content, author: { id: 'bot' } }], config, 'scope', 'revision').state, state);
});

test('duplicate generated quizzes have a deterministic canonical thread', () => {
  const config = { stateKey: key, botId: 'bot' };
  const comments = [3, 1, 2].map(threadId => ({ threadId, content: seal(state, key), author: { id: 'bot' } }));
  assert.equal(findState(comments, config, 'scope', 'revision').comment.threadId, 1);
});

test('complete numbered answers are accepted case-insensitively', () => {
  assert.deepEqual(parseAnswers('/buut answer id\n1: b\n2: C', 'id', 2), { 1: 'B', 2: 'C' });
});

for (const [name, input] of Object.entries({
  incomplete: '/buut answer id\n1: B', duplicate: '/buut answer id\n1:B\n1:C\n2:A',
  extra: '/buut answer id\n1:B\n2:C\n3:A', invalid: '/buut answer id\n1:E\n2:C',
  stale: '/buut answer old\n1:B\n2:C', quoted: '> /buut answer id\n1:B\n2:C',
  explanation: '/buut answer id\n1:B because\n2:C',
})) test(`rejects ${name} submission`, () => assert.equal(parseAnswers(input, 'id', 2), null));

test('all answers must be correct', () => {
  const questions = [{ answer: 'B' }, { answer: 'A' }];
  assert.deepEqual(grade(questions, { 1: 'B', 2: 'C' }), { passed: false, incorrect: [2] });
  assert.deepEqual(grade(questions, { 1: 'B', 2: 'A' }), { passed: true, incorrect: [] });
});

test('revision includes PR author, iteration, source, target, and merge base', () => {
  const pr = { createdBy: { id: 'author' } };
  const iteration = { id: 1, sourceRefCommit: { commitId: 'source' }, targetRefCommit: { commitId: 'target' }, commonRefCommit: { commitId: 'base' } };
  const revision = revisionOf(pr, iteration);
  for (const field of ['sourceRefCommit', 'targetRefCommit', 'commonRefCommit']) {
    assert.notEqual(revisionOf(pr, { ...iteration, [field]: { commitId: 'changed' } }), revision);
  }
  assert.notEqual(revisionOf({ createdBy: { id: 'other' } }, iteration), revision);
  assert.throws(() => revisionOf(pr, { id: 1 }), /incomplete/);
});

test('state is bound to organization, project, repository, and PR ID', () => {
  const config = { orgUrl: 'https://dev.azure.com/org', project: 'project', repository: 'repo' };
  assert.notEqual(scopeOf(config, 1), scopeOf(config, 2));
  assert.notEqual(scopeOf(config, 1), scopeOf({ ...config, repository: 'other' }, 1));
});
