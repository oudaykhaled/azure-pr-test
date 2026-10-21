import test from 'node:test';
import assert from 'node:assert/strict';
import { AzureClient } from '../src/azure.js';
const config = { orgUrl: 'https://dev.azure.com/org', project: 'My Project', repository: 'repo', token: 'secret-token', authType: 'bearer', maxFiles: 3, maxContextChars: 1000, excludePrefixes: [] };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const pr = { pullRequestId: 1, title: 'Change', description: 'Description' };
const iteration = { id: 2, commonRefCommit: { commitId: 'base' }, sourceRefCommit: { commitId: 'head' } };

test('encodes Azure URLs and authenticates without tokens in URL or body', async () => {
  const client = new AzureClient(config, async (url, options) => {
    assert.equal(url.pathname, '/org/My%20Project/_apis/git/repositories/repo/pullrequests/1');
    assert.equal(url.searchParams.get('api-version'), '7.1');
    assert.equal(options.headers.Authorization, 'Bearer secret-token');
    assert.equal(options.redirect, 'error');
    assert.equal(url.href.includes('secret-token'), false);
    return json(pr);
  });
  assert.deepEqual(await client.pr(1), pr);
});

test('supports PAT authentication', async () => {
  const client = new AzureClient({ ...config, authType: 'pat' }, async (_url, options) => {
    assert.equal(options.headers.Authorization, `Basic ${Buffer.from(':secret-token').toString('base64')}`);
    return json(pr);
  });
  await client.pr(1);
});

test('HTTP errors do not expose provider response bodies or secrets', async () => {
  const client = new AzureClient(config, async () => new Response('secret-token private response', { status: 401 }));
  await assert.rejects(client.pr(1), error => /HTTP 401/.test(error.message) && !error.message.includes('secret-token'));
});

test('paginates active PRs', async () => {
  const pages = [];
  const client = new AzureClient(config, async url => {
    const skip = url.searchParams.get('$skip'); pages.push(skip);
    return json({ value: skip === '0' ? Array.from({ length: 100 }, (_, i) => ({ pullRequestId: i + 1 })) : [{ pullRequestId: 101 }] });
  });
  assert.equal((await client.activePRs()).length, 101);
  assert.deepEqual(pages, ['0', '100']);
});

test('uses full PR changes versus common commit and paginates entries', async () => {
  const client = new AzureClient(config, async url => {
    assert.equal(url.searchParams.get('$compareTo'), '0');
    return json(url.searchParams.get('$skip') === '0'
      ? { changeEntries: [{ item: { path: '/a.js' } }], nextSkip: 1 }
      : { changeEntries: [{ item: { path: '/b.js' } }], nextSkip: 0 });
  });
  assert.equal((await client.changes(1, 2)).length, 2);
});

test('posts status bound to iteration and named Azure policy context', async () => {
  const client = new AzureClient(config, async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.iterationId, 2);
    assert.equal(body.state, 'succeeded');
    assert.deepEqual(body.context, { genre: 'buut', name: 'pr-test' });
    return json({ id: 1 });
  });
  await client.status(1, 2, 'succeeded', 'Passed');
});

function contextClient(entries, item = async (_path, commit) => commit === 'base' ? 'old' : 'new', overrides = {}) {
  const client = new AzureClient({ ...config, ...overrides });
  client.changes = async () => entries;
  client.item = item;
  return client;
}

test('context supplies real before and after versions with rename paths', async () => {
  const calls = [];
  const client = contextClient([{ originalPath: '/old.js', item: { path: '/new.js' }, changeType: 'rename' }], async (path, commit) => { calls.push([path, commit]); return path; });
  const context = await client.context(pr, iteration);
  assert.deepEqual(calls, [['/old.js', 'base'], ['/new.js', 'head']]);
  assert.equal(context.files[0].before, '/old.js');
});

test('deleted file carries null after content', async () => {
  const client = contextClient([{ item: { path: '/old.js' }, changeType: 'delete' }], async (_path, commit) => commit === 'base' ? 'old' : null);
  const context = await client.context(pr, iteration);
  assert.equal(context.files[0].after, null);
});

test('fails instead of silently truncating oversized context', async () => {
  const client = contextClient([{ item: { path: '/big.js' } }], async () => 'x'.repeat(1000));
  await assert.rejects(client.context(pr, iteration), /MAX_CONTEXT/);
});

test('fails oversized file lists and unsupported forks', async () => {
  const client = contextClient(Array.from({ length: 4 }, () => ({ item: { path: '/x' } })));
  await assert.rejects(client.context(pr, iteration), /MAX_FILES/);
  await assert.rejects(client.context({ ...pr, forkSource: { repository: {} } }, iteration), /Fork PRs/);
});

test('explicit exclusions do not auto-pass an uncovered PR', async () => {
  const client = contextClient([{ item: { path: '/assets/icon.png' } }], undefined, { excludePrefixes: ['/assets/'] });
  await assert.rejects(client.context(pr, iteration), /No included files/);
});

test('binary file content fails closed', async () => {
  const client = new AzureClient(config, async () => json({ contentMetadata: { isBinary: true } }));
  await assert.rejects(client.item('/image.png', 'head'), /binary/);
});

test('missing file is represented as absent only on 404', async () => {
  const client = new AzureClient(config, async () => new Response('', { status: 404 }));
  assert.equal(await client.item('/new.js', 'base'), null);
  client.fetcher = async () => new Response('', { status: 403 });
  await assert.rejects(client.item('/new.js', 'base'), /HTTP 403/);
});

test('an edited file with a missing base version cannot silently become an added file', async () => {
  const client = contextClient([{ item: { path: '/edited.js' }, changeType: 'edit' }], async (_path, commit) => commit === 'base' ? null : 'new');
  await assert.rejects(client.context(pr, iteration), /incomplete context/);
});
