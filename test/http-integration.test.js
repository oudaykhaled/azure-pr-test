import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { AzureClient } from '../src/azure.js';
import { generateQuiz } from '../src/model.js';
import { processPR } from '../src/runner.js';
import { unseal } from '../src/state.js';

test('HTTP flow: fetch Azure PR, generate quiz, persist, grade author, reset on push', async () => {
  const config = { orgUrl: 'https://dev.azure.com/demo', project: 'project', repository: 'repo', token: 'fixture-token', authType: 'bearer',
    botId: 'bot', stateKey: 'a'.repeat(64), maxFiles: 10, maxContextChars: 5000, excludePrefixes: [],
    questionCount: 1, maxAttempts: 3, provider: 'openai', model: 'fixture-model', apiKey: 'fixture-model-key' };
  const pr = { pullRequestId: 1, title: 'Handle missing accounts', status: 'active', createdBy: { id: 'author' } };
  const iteration = { id: 1, commonRefCommit: { commitId: 'base' }, sourceRefCommit: { commitId: 'source' }, targetRefCommit: { commitId: 'target' } };
  const threads = [], statuses = [];
  let generations = 0;
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      let body = ''; for await (const chunk of req) body += chunk;
      const data = body ? JSON.parse(body) : null;
      res.setHeader('Content-Type', 'application/json');
      const respond = value => res.end(JSON.stringify(value));
      if (url.pathname === '/model') {
        assert.equal(req.headers.authorization, 'Bearer fixture-model-key');
        assert.ok(data.messages[1].content.includes('return null'));
        generations++;
        return respond({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ questions: [{
          question: 'How is a missing account handled?', choices: { A: 'Return null', B: 'Delete it', C: 'Retry', D: 'Throw' }, answer: 'A', evidencePath: '/account.js',
        }] }) } }] });
      }
      assert.equal(req.headers.authorization, 'Bearer fixture-token');
      assert.equal(url.searchParams.get('api-version'), '7.1');
      if (url.pathname.endsWith('/iterations/1/changes') || url.pathname.endsWith('/iterations/2/changes')) {
        return respond({ changeEntries: [{ item: { path: '/account.js' }, changeType: 'edit' }], nextSkip: 0 });
      }
      if (url.pathname.endsWith('/items')) {
        return respond({ content: url.searchParams.get('versionDescriptor.version') === 'base' ? 'throw new Error()' : 'return null', contentMetadata: { isBinary: false } });
      }
      if (url.pathname.endsWith('/iterations')) return respond({ value: [iteration] });
      if (url.pathname.endsWith('/statuses')) { statuses.push(data); return respond({ id: statuses.length, ...data }); }
      if (url.pathname.endsWith('/threads')) {
        if (req.method === 'POST') {
          const thread = { id: threads.length + 1, comments: data.comments.map((c, i) => ({ ...c, id: i + 1, author: { id: 'bot' }, publishedDate: new Date().toISOString() })) };
          threads.push(thread); return respond(thread);
        }
        return respond({ value: threads });
      }
      const match = url.pathname.match(/\/threads\/(\d+)\/comments\/(\d+)$/);
      if (match && req.method === 'PATCH') {
        const comment = threads.find(t => t.id === Number(match[1])).comments.find(c => c.id === Number(match[2]));
        comment.content = data.content; return respond(comment);
      }
      if (url.pathname.endsWith('/pullrequests/1')) return respond(pr);
      res.statusCode = 404; respond({ error: 'unknown fixture route' });
    } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ error: error.message })); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const azureFetch = (url, options) => fetch(`${origin}${url.pathname}${url.search}`, options);
  const providerFetch = (_url, options) => fetch(`${origin}/model`, options);
  const client = new AzureClient(config, azureFetch);
  const execute = () => processPR(client, config, 1, context => generateQuiz(config, context, providerFetch));
  try {
    assert.equal((await execute()).result, 'pending');
    const first = unseal(threads[0].comments[0].content, config.stateKey);
    assert.equal(generations, 1);
    threads.push({ id: 2, comments: [{ id: 1, author: { id: 'author' }, publishedDate: new Date(Date.now() + 1000).toISOString(), content: `/buut answer ${first.quizId}\n1: A` }] });
    assert.equal((await execute()).result, 'succeeded');
    assert.equal(statuses.at(-1).state, 'succeeded');
    assert.equal(statuses.at(-1).iterationId, 1);
    assert.equal(generations, 1);
    iteration.id = 2; iteration.sourceRefCommit.commitId = 'source-2';
    assert.equal((await execute()).result, 'pending');
    assert.equal(generations, 2);
    assert.equal(statuses.at(-1).iterationId, 2);
    const second = unseal(threads.at(-1).comments[0].content, config.stateKey);
    assert.notEqual(first.quizId, second.quizId);
    assert.equal(second.passed, false);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
