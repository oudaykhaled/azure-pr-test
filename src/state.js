import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const prefix = 'buut-pr-test:v1:';

export function scopeOf(config, prId) {
  return JSON.stringify([config.orgUrl.toLowerCase(), config.project.toLowerCase(), config.repository.toLowerCase(), prId]);
}

export function revisionOf(pr, iteration) {
  const parts = [pr.createdBy?.id, iteration.id, iteration.sourceRefCommit?.commitId,
    iteration.targetRefCommit?.commitId, iteration.commonRefCommit?.commitId];
  if (parts.some(x => x === undefined || x === null || x === '')) throw new Error('Azure returned incomplete PR revision metadata');
  parts.push(pr.sourceRefName || '', pr.targetRefName || '',
    pr.lastMergeSourceCommit?.commitId || '', pr.lastMergeTargetCommit?.commitId || '');
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

export function seal(state, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv);
  cipher.setAAD(Buffer.from(prefix));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(state), 'utf8'), cipher.final()]);
  return `<!-- ${prefix}${Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url')} -->`;
}

export function unseal(content, key) {
  const match = content?.match(/<!-- buut-pr-test:v1:([A-Za-z0-9_-]+) -->/);
  if (!match) return null;
  try {
    const data = Buffer.from(match[1], 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'hex'), data.subarray(0, 12));
    decipher.setAAD(Buffer.from(prefix));
    decipher.setAuthTag(data.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8'));
  } catch {
    throw new Error('Cannot decrypt quiz state; restore QUIZ_STATE_KEY or remove the obsolete bot quiz thread to regenerate');
  }
}

export function commentsOf(threads) {
  return threads.filter(t => !t.isDeleted).flatMap(t => (t.comments || [])
    .filter(c => !c.isDeleted).map(c => ({ ...c, threadId: t.id })));
}

export function findState(comments, config, scope, revision) {
  const states = [];
  for (const comment of comments) {
    if (comment.author?.id?.toLowerCase() !== config.botId) continue;
    const state = unseal(comment.content, config.stateKey);
    if (state?.scope === scope && state.revision === revision) states.push({ state, comment });
  }
  // Concurrent initial generators can create duplicates. Select the first Azure thread deterministically.
  return states.sort((a, b) => a.comment.threadId - b.comment.threadId)[0] || null;
}

export function parseAnswers(content, quizId, count) {
  const lines = content.trim().split(/\r?\n/).map(x => x.trim());
  if (lines[0] !== `/buut answer ${quizId}`) return null;
  const answers = {};
  for (const line of lines.slice(1).filter(Boolean)) {
    const match = line.match(/^(\d+)\s*:\s*([A-Da-d])$/);
    if (!match) return null;
    const number = Number(match[1]);
    if (number < 1 || number > count || answers[number]) return null;
    answers[number] = match[2].toUpperCase();
  }
  return Object.keys(answers).length === count ? answers : null;
}

export function grade(questions, answers) {
  const incorrect = questions.flatMap((q, index) => answers[index + 1] === q.answer ? [] : [index + 1]);
  return { passed: incorrect.length === 0, incorrect };
}
