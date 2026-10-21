function required(env, name) {
  const value = env[name]?.trim();
  if (!value || /^\$\(.+\)$/.test(value)) throw new Error(`Set ${name}`);
  return value;
}

function integer(env, name, fallback, min, max) {
  const raw = env[name] || String(fallback);
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer`);
  const value = Number(raw);
  if (value < min || value > max) throw new Error(`${name} must be ${min}–${max}`);
  return value;
}

function httpsUrl(value, name) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} must be an HTTPS URL without credentials, query, or fragment`);
  }
  return url.href.replace(/\/$/, '');
}

export function loadConfig(env = process.env) {
  const orgUrl = httpsUrl(required(env, 'AZURE_ORG_URL'), 'AZURE_ORG_URL');
  const org = new URL(orgUrl);
  if (!((org.hostname === 'dev.azure.com' && /^\/[^/]+$/.test(org.pathname)) ||
    (org.hostname.endsWith('.visualstudio.com') && org.pathname === '/'))) {
    throw new Error('AZURE_ORG_URL must identify an Azure DevOps Services organization');
  }
  const stateKey = required(env, 'QUIZ_STATE_KEY');
  if (!/^[a-fA-F0-9]{64}$/.test(stateKey)) throw new Error('QUIZ_STATE_KEY must be 32 random bytes encoded as 64 hex characters');
  const provider = env.LLM_PROVIDER || 'azure-openai';
  if (!['azure-openai', 'openai'].includes(provider)) throw new Error('LLM_PROVIDER must be azure-openai or openai');
  const authType = env.AZURE_AUTH_TYPE || 'bearer';
  if (!['bearer', 'pat'].includes(authType)) throw new Error('AZURE_AUTH_TYPE must be bearer or pat');
  const config = {
    orgUrl, project: required(env, 'AZURE_PROJECT'), repository: required(env, 'AZURE_REPOSITORY_ID'),
    token: required(env, 'AZURE_TOKEN'), authType, stateKey,
    botId: required(env, 'AZURE_BOT_ID').toLowerCase(), provider,
    questionCount: integer(env, 'QUIZ_QUESTION_COUNT', 3, 1, 5),
    maxAttempts: integer(env, 'QUIZ_MAX_ATTEMPTS', 3, 1, 10),
    maxFiles: integer(env, 'QUIZ_MAX_FILES', 30, 1, 100),
    maxContextChars: integer(env, 'QUIZ_MAX_CONTEXT_CHARS', 80000, 1000, 200000),
    prId: env.PR_ID ? integer(env, 'PR_ID', 0, 1, 2147483647) : undefined,
    excludePrefixes: (env.QUIZ_EXCLUDE_PREFIXES || '').split(',').map(x => x.trim()).filter(Boolean),
  };
  if (provider === 'azure-openai') {
    config.endpoint = httpsUrl(required(env, 'AZURE_OPENAI_ENDPOINT'), 'AZURE_OPENAI_ENDPOINT');
    config.apiKey = required(env, 'AZURE_OPENAI_API_KEY');
    config.model = required(env, 'AZURE_OPENAI_DEPLOYMENT');
    config.apiVersion = env.AZURE_OPENAI_API_VERSION || '2024-10-21';
  } else {
    config.apiKey = required(env, 'OPENAI_API_KEY');
    config.model = env.OPENAI_MODEL || 'gpt-4.1-mini';
  }
  return config;
}
