const KEEP = new Set(["PATH", "HOME", "LANG", "LC_ALL", "TERM", "TMPDIR", "TEMP", "TMP", "USER", "LOGNAME", "SHELL"]);

const SECRET_NAME =
  /^(?:.+_)?(?:API_KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS|ACCESS_KEY|PRIVATE_KEY)$|^MCP_.+$/i;

/**
 * Provider credentials a child `pi` process needs to authenticate. Without these a
 * subagent starts and immediately fails with "no API key", because every one of them
 * is also secret-shaped. Mirrors the provider table in pi's docs/providers.md.
 */
const PROVIDER_CREDENTIAL_ENV = new Set(
  [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_OAUTH_TOKEN",
    "ANT_LING_API_KEY",
    "AZURE_OPENAI_API_KEY",
    "OPENAI_API_KEY",
    "DEEPSEEK_API_KEY",
    "NVIDIA_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "AWS_BEARER_TOKEN_BEDROCK",
    "MISTRAL_API_KEY",
    "GROQ_API_KEY",
    "CEREBRAS_API_KEY",
    "CLOUDFLARE_API_KEY",
    "CLOUDFLARE_ACCOUNT_ID",
    "CLOUDFLARE_GATEWAY_ID",
    "XAI_API_KEY",
    "OPENROUTER_API_KEY",
    "AI_GATEWAY_API_KEY",
    "ZAI_API_KEY",
    "ZAI_CODING_CN_API_KEY",
    "OPENCODE_API_KEY",
    "RADIUS_API_KEY",
    "HF_TOKEN",
    "FIREWORKS_API_KEY",
    "TOGETHER_API_KEY",
    "BASETEN_API_KEY",
    "KIMI_API_KEY",
    "MINIMAX_API_KEY",
    "MINIMAX_CN_API_KEY",
    "QWEN_TOKEN_PLAN_API_KEY",
    "QWEN_TOKEN_PLAN_CN_API_KEY",
    "XIAOMI_API_KEY",
    "XIAOMI_TOKEN_PLAN_CN_API_KEY",
    "XIAOMI_TOKEN_PLAN_AMS_API_KEY",
    "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
  ].map((name) => name.toUpperCase()),
);

export function isSecretEnvKey(key: string): boolean {
  return SECRET_NAME.test(key);
}

/** True for credentials a nested `pi` needs to reach a model provider. */
export function isProviderCredentialEnvKey(key: string): boolean {
  return PROVIDER_CREDENTIAL_ENV.has(key.toUpperCase());
}

export interface SanitizeEnvOptions {
  /** Keep model-provider credentials so a child `pi` can authenticate. Default true. */
  keepProviderCredentials?: boolean;
}

/** Child-process env: keep the parent environment except secret-shaped keys. */
export function sanitizeEnv(
  source: NodeJS.ProcessEnv = process.env,
  extra: Record<string, string> = {},
  options: SanitizeEnvOptions = {},
): Record<string, string> {
  const keepProviderCredentials = options.keepProviderCredentials !== false;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (KEEP.has(key)) {
      out[key] = value;
      continue;
    }
    if (isSecretEnvKey(key)) {
      if (keepProviderCredentials && isProviderCredentialEnvKey(key)) out[key] = value;
      continue;
    }
    out[key] = value;
  }
  for (const [key, value] of Object.entries(extra)) {
    out[key] = value;
  }
  return out;
}

export function interpolateEnvValue(raw: string, env: NodeJS.ProcessEnv = process.env, missing: string[] = []): string {
  let value = raw.replace(/^~(?=\/|$)/, env.HOME ?? "");
  const pattern = /\$\{([A-Z0-9_]+)\}|\$env:([A-Z0-9_]+)/gi;
  value = value.replace(pattern, (_whole, brace: string | undefined, envStyle: string | undefined) => {
    const name = brace ?? envStyle ?? "";
    const found = env[name];
    if (found === undefined) {
      if (!missing.includes(name)) missing.push(name);
      return "";
    }
    return found;
  });
  return value;
}

export function interpolateRecord(
  input: Record<string, string> | undefined,
  env: NodeJS.ProcessEnv = process.env,
): { values: Record<string, string>; missing: string[] } {
  const values: Record<string, string> = {};
  const missing: string[] = [];
  if (!input) return { values, missing };
  for (const [key, raw] of Object.entries(input)) {
    values[key] = interpolateEnvValue(raw, env, missing);
  }
  return { values, missing };
}

export function combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal {
  const present = signals.filter((s): s is AbortSignal => Boolean(s));
  if (present.length === 0) return new AbortController().signal;
  if (present.length === 1) return present[0];
  return AbortSignal.any(present);
}

export function timeoutSignal(ms: number, parent?: AbortSignal): AbortSignal {
  if (!Number.isFinite(ms) || ms <= 0) return parent ?? new AbortController().signal;
  return combineSignals(parent, AbortSignal.timeout(ms));
}
