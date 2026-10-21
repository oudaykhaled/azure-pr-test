export class AzureClient {
  constructor(config, fetcher = fetch) {
    this.config = config;
    this.fetcher = fetcher;
    this.base = `${config.orgUrl}/${encodeURIComponent(config.project)}/_apis/git/repositories/${encodeURIComponent(config.repository)}`;
    this.authorization = config.authType === 'pat'
      ? `Basic ${Buffer.from(`:${config.token}`).toString('base64')}` : `Bearer ${config.token}`;
  }

  async request(path, { method = 'GET', body, query = {}, missing = false } = {}) {
    const url = new URL(`${this.base}${path}`);
    url.search = new URLSearchParams({ 'api-version': '7.1', ...query }).toString();
    const response = await this.fetcher(url, {
      method, redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { Authorization: this.authorization, Accept: 'application/json', 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (missing && response.status === 404) return null;
    if (!response.ok) throw new Error(`Azure DevOps ${method} ${path}: HTTP ${response.status}`);
    return response.json();
  }

  async activePRs() {
    const prs = [];
    for (let skip = 0; ; skip += 100) {
      const result = await this.request('/pullrequests', { query: { 'searchCriteria.status': 'active', '$top': '100', '$skip': String(skip) } });
      prs.push(...result.value);
      if (result.value.length < 100) return prs;
    }
  }

  pr(id) { return this.request(`/pullrequests/${id}`); }
  async iteration(id) {
    const result = await this.request(`/pullrequests/${id}/iterations`);
    const latest = result.value.reduce((a, b) => !a || b.id > a.id ? b : a, null);
    if (!latest) throw new Error('PR has no iterations');
    return latest;
  }
  async threads(id) { return (await this.request(`/pullrequests/${id}/threads`)).value; }
  createThread(id, content) {
    return this.request(`/pullrequests/${id}/threads`, { method: 'POST', body: { comments: [{ parentCommentId: 0, content, commentType: 1 }], status: 4 } });
  }
  updateComment(id, threadId, commentId, content) {
    return this.request(`/pullrequests/${id}/threads/${threadId}/comments/${commentId}`, { method: 'PATCH', body: { content } });
  }
  status(id, iterationId, state, description) {
    return this.request(`/pullrequests/${id}/statuses`, { method: 'POST', body: {
      state, description, iterationId, context: { genre: 'buut', name: 'pr-test' },
      targetUrl: `${this.config.orgUrl}/${encodeURIComponent(this.config.project)}/_git/${encodeURIComponent(this.config.repository)}/pullrequest/${id}`,
    } });
  }

  async changes(id, iterationId) {
    const entries = [];
    let skip = 0;
    do {
      const result = await this.request(`/pullrequests/${id}/iterations/${iterationId}/changes`, {
        query: { '$compareTo': '0', '$top': '100', '$skip': String(skip) },
      });
      entries.push(...result.changeEntries);
      if (!result.nextSkip) return entries;
      if (result.nextSkip <= skip) throw new Error('Azure changes pagination did not advance');
      skip = result.nextSkip;
    } while (true);
  }

  async item(path, commit) {
    const result = await this.request('/items', { missing: true, query: {
      path, 'versionDescriptor.version': commit, 'versionDescriptor.versionType': 'commit', includeContent: 'true', includeContentMetadata: 'true',
    } });
    if (!result) return null;
    if (result.isFolder) return null;
    if (result.contentMetadata?.isBinary || typeof result.content !== 'string') {
      throw new Error('Unsupported binary or unavailable file content in PR; exclude that path explicitly');
    }
    return result.content;
  }

  async context(pr, iteration) {
    if (pr.forkSource) throw new Error('Fork PRs are not supported; use a source branch in the same repository');
    const entries = (await this.changes(pr.pullRequestId, iteration.id))
      .filter(e => !e.item?.isFolder)
      .filter(e => !this.config.excludePrefixes.some(prefix => e.item.path.startsWith(prefix)));
    if (!entries.length) throw new Error('No included files to quiz; review exclusion settings');
    if (entries.length > this.config.maxFiles) throw new Error('PR exceeds QUIZ_MAX_FILES; split the PR or review exclusions');
    const files = [];
    let size = 0;
    for (const entry of entries) {
      const path = entry.item?.path;
      if (!path) throw new Error('Azure returned a changed file without a path');
      const before = await this.item(entry.originalPath || path, iteration.commonRefCommit.commitId);
      const after = await this.item(path, iteration.sourceRefCommit.commitId);
      if (before === null && after === null) throw new Error('Both versions of a changed file are unavailable');
      const type = String(entry.changeType || '').toLowerCase();
      if ((before === null && !type.includes('add')) || (after === null && !type.includes('delete'))) {
        throw new Error('A required file version is unavailable; refusing to grade incomplete context');
      }
      const file = { path, changeType: entry.changeType, before, after };
      size += JSON.stringify(file).length;
      if (size > this.config.maxContextChars) throw new Error('PR exceeds QUIZ_MAX_CONTEXT_CHARS; content will not be silently truncated');
      files.push(file);
    }
    return { title: pr.title, description: (pr.description || '').slice(0, 5000), files };
  }
}
