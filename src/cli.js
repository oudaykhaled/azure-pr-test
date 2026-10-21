import { loadConfig } from './config.js';
import { AzureClient } from './azure.js';
import { generateQuiz } from './model.js';
import { run } from './runner.js';

try {
  const config = loadConfig();
  const result = await run(new AzureClient(config), config, context => generateQuiz(config, context));
  console.log(`Checked ${result.total} PR(s); ${result.failures} operational error(s).`);
  if (result.failures) process.exitCode = 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
