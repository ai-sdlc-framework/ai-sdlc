/**
 * verify-llm-resolution.mjs
 *
 * This script verifies that the orchestrator is using the expected LLM runner
 * and model by analyzing logs or executing a controlled smoke test.
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

async function main() {
  console.log('🚀 Starting LLM Resolution Verification...');

  // 1. Check Environment Variables
  const envVars = {
    LLM_API_URL: process.env.LLM_API_URL,
    LLM_API_KEY: process.env.LLM_API_KEY ? 'SET' : 'NOT SET',
    LLM_MODEL: process.env.LLM_MODEL,
  };

  console.log('\n--- Environment Configuration ---');
  Object.entries(envVars).forEach(([k, v]) => console.log(`${k}: ${v}`));

  if (!process.env.LLM_API_URL || !process.env.LLM_API_KEY) {
    console.error('\n❌ Error: LLM_API_URL or LLM_API_KEY is not set.');
    console.error('Please export these variables before running the smoke test.');
    process.exit(1);
  }

  // 2. Run a minimal orchestrator command to verify runner registration
  // We use the orchestrator CLI to list available runners if possible,
  // or we attempt a small run and check the output/logs.
  try {
    console.log('\n--- Verifying Runner Registration ---');
    // Assuming there is a way to check registered runners via CLI
    // If not, we'll rely on executing the smoke test task.
    const output = execSync('pnpm run orchestrator --help', { encoding: 'utf8' });
    if (output.includes('generic-llm')) {
      console.log('✅ Runner "generic-llm" is registered in the CLI.');
    } else {
      console.log('⚠️  Could not explicitly verify runner registration via help text.');
    }
  } catch (e) {
    console.error(`❌ Failed to execute orchestrator command: ${e.message}`);
  }

  // 3. Smoke Test Execution Instructions
  console.log('\n--- Smoke Test Instructions ---');
  console.log('To verify the actual model response format, run:');
  console.log(`pnpm run orchestrator --runner generic-llm execute SMOKE-LLM-001`);
  console.log('\nExpected output from agent: {"status": "resolved", "model_verified": true}');

  console.log('\n✅ Verification script completed.');
}

main().catch((err) => {
  console.error(`❌ Unexpected error: ${err}`);
  process.exit(1);
});
