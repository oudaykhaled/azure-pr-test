import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { generateQuiz, validateQuiz } from '../src/model.js';

const env = { AZURE_ORG_URL: 'https://dev.azure.com/org', AZURE_PROJECT: 'Project', AZURE_REPOSITORY_ID: 'repo',
  AZURE_BOT_ID: 'bot', AZURE_TOKEN: 'token', QUIZ_STATE_KEY: 'a'.repeat(64),
  AZURE_OPENAI_ENDPOINT: 'https://resource.openai.azure.com', AZURE_OPENAI_API_KEY: 'model-secret', AZURE_OPENAI_DEPLOYMENT: 'deployment' };
const context = { files: [{ path: '/app.js', before: 'old', after: 'new' }] };
const q = { question: 'What does this change?', choices: { A: 'Retries', B: 'Deletes', C: 'Throws', D: 'Returns' }, answer: 'A', evidencePath: '/app.js' };
const response = value => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] }), { headers: { 'Content-Type': 'application/json' } });

test('valid configuration defaults to Azure OpenAI and bearer auth', () => {
  const config = loadConfig(env);
  assert.equal(config.provider, 'azure-openai'); assert.equal(config.authType, 'bearer');
  assert.equal(config.questionCount, 3); assert.equal(config.maxAttempts, 3);
});

for (const [name, value, pattern] of [
  ['QUIZ_STATE_KEY', 'short', /32 random/], ['QUIZ_MAX_ATTEMPTS', '0', /1–10/],
  ['QUIZ_QUESTION_COUNT', '3junk', /integer/], ['AZURE_TOKEN', '$(MISSING)', /Set AZURE_TOKEN/],
  ['AZURE_ORG_URL', 'https://attacker.example/org', /organization/],
  ['AZURE_ORG_URL', 'http://dev.azure.com/org', /HTTPS/],
  ['AZURE_OPENAI_ENDPOINT', 'https://user:password@example.com', /credentials/],
  ['LLM_PROVIDER', 'other', /LLM_PROVIDER/], ['AZURE_AUTH_TYPE', 'other', /AZURE_AUTH_TYPE/],
]) test(`rejects invalid configuration ${name}=${value}`, () => assert.throws(() => loadConfig({ ...env, [name]: value }), pattern));

test('supports public OpenAI without requiring Azure OpenAI secrets', () => {
  const config = loadConfig({ ...env, LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'key', AZURE_OPENAI_API_KEY: '' });
  assert.equal(config.apiKey, 'key'); assert.equal(config.provider, 'openai');
});

test('Azure model request uses structured output with only PR content', async () => {
  const config = { ...loadConfig(env), questionCount: 1 };
  const quiz = await generateQuiz(config, context, async (url, options) => {
    assert.ok(url.startsWith('https://resource.openai.azure.com/openai/deployments/deployment/chat/completions'));
    assert.equal(options.headers['api-key'], 'model-secret');
    const body = JSON.parse(options.body);
    assert.equal(body.response_format.json_schema.strict, true);
    assert.equal(body.messages[1].content, JSON.stringify(context));
    assert.equal(options.body.includes('model-secret'), false);
    assert.equal(options.body.includes('"token"'), false);
    return response({ questions: [q] });
  });
  assert.equal(quiz.questions[0].answer, 'A');
});

test('public OpenAI uses Authorization header and model name', async () => {
  const config = { ...loadConfig({ ...env, LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'key' }), questionCount: 1 };
  await generateQuiz(config, context, async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(options.headers.Authorization, 'Bearer key');
    assert.equal(JSON.parse(options.body).model, 'gpt-4.1-mini');
    return response({ questions: [q] });
  });
});

test('rejects hallucinated evidence, ambiguous choices, and incorrect count', () => {
  assert.throws(() => validateQuiz({ questions: [{ ...q, evidencePath: '/imaginary.js' }] }, context, 1), /invalid/);
  assert.throws(() => validateQuiz({ questions: [{ ...q, choices: { A: 'Same', B: 'Same', C: 'c', D: 'd' } }] }, context, 1), /invalid/);
  assert.throws(() => validateQuiz({ questions: [q] }, context, 3), /number/);
});

test('provider errors never expose raw responses', async () => {
  await assert.rejects(generateQuiz(loadConfig(env), context, async () => new Response('secret', { status: 429 })),
    error => /HTTP 429/.test(error.message) && !error.message.includes('secret'));
});

test('refusal and incomplete model responses are rejected', async () => {
  const fetcher = async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '{}' } }] }));
  await assert.rejects(generateQuiz(loadConfig(env), context, fetcher), /incomplete/);
});
