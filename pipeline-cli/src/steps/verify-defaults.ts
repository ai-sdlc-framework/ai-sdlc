/**
 * The default verification command list (AISDLC-1086). One list for the dispatch manifest
 * (`dispatch/enqueue.ts`), `execute-pipeline` and `next-step`. Import-free on purpose: the
 * dispatch board loads it without pulling in the process runner.
 *
 * @module steps/verify-defaults
 */

export const DEFAULT_VERIFY_COMMANDS = [
  'pnpm build',
  'pnpm test',
  'pnpm lint',
  'pnpm format:check',
] as const;

export const VERIFICATION_KEYS = ['build', 'test', 'lint', 'format'] as const;
export type VerificationKey = (typeof VERIFICATION_KEYS)[number];
/** Per-key command; a missing key means "not configured" (the step is skipped). */
export type VerificationCommands = Partial<Record<VerificationKey, string>>;

/** Repo-relative file holding the `verification:` block (AISDLC-1263). */
export const VERIFICATION_CONFIG_PATH = '.ai-sdlc/verification.yaml';

export const DEFAULT_VERIFICATION: Readonly<Required<VerificationCommands>> = {
  build: DEFAULT_VERIFY_COMMANDS[0],
  test: DEFAULT_VERIFY_COMMANDS[1],
  lint: DEFAULT_VERIFY_COMMANDS[2],
  format: DEFAULT_VERIFY_COMMANDS[3],
};

/**
 * Resolve the `verification` block: absent (or not a mapping) keeps the pnpm defaults; a
 * present block lists exactly the configured commands, so an omitted key is skipped.
 */
export function resolveVerification(block: unknown): VerificationCommands {
  if (block === null || typeof block !== 'object' || Array.isArray(block)) {
    return { ...DEFAULT_VERIFICATION };
  }
  const out: VerificationCommands = {};
  for (const key of VERIFICATION_KEYS) {
    const v = (block as Record<string, unknown>)[key];
    if (typeof v === 'string' && v.trim() !== '') out[key] = v.trim();
  }
  return out;
}

/** The configured commands in build, test, lint, format order. */
export function verificationCommandList(v: VerificationCommands): string[] {
  return VERIFICATION_KEYS.flatMap((k) => (v[k] ? [v[k] as string] : []));
}

/** Detected defaults for `init`: `package.json` wins over `pyproject.toml`; neither yields none. */
export function detectVerificationDefaults(
  exists: (file: string) => boolean,
): VerificationCommands | undefined {
  if (exists('package.json')) return { ...DEFAULT_VERIFICATION };
  if (exists('pyproject.toml')) {
    return {
      build: 'uv build',
      test: 'uv run pytest',
      lint: 'uv run ruff check .',
      format: 'uv run ruff format --check .',
    };
  }
  return undefined;
}

export function renderVerificationYaml(v: VerificationCommands): string {
  const lines = VERIFICATION_KEYS.flatMap((k) => (v[k] ? [`  ${k}: ${JSON.stringify(v[k])}`] : []));
  return `# Verification commands (AISDLC-1263). Omit a key to skip that step.\nverification:\n${lines.join('\n')}\n`;
}
