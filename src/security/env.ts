const KEEP = new Set(["PATH", "HOME", "LANG", "LC_ALL", "TERM", "TMPDIR", "TEMP", "TMP", "USER", "LOGNAME", "SHELL"]);

const SECRET_NAME =
  /^(?:.+_)?(?:API_KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS|ACCESS_KEY|PRIVATE_KEY)$|^MCP_.+$/i;

export function isSecretEnvKey(key: string): boolean {
  return SECRET_NAME.test(key);
}

/** Child-process env: keep the parent environment except secret-shaped keys. */
export function sanitizeEnv(
  source: NodeJS.ProcessEnv = process.env,
  extra: Record<string, string> = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (KEEP.has(key)) {
      out[key] = value;
      continue;
    }
    if (isSecretEnvKey(key)) continue;
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
      missing.push(name);
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
  if (present.length === 0) return AbortSignal.timeout(2 ** 31 - 1);
  if (present.length === 1) return present[0];
  return AbortSignal.any(present);
}

export function timeoutSignal(ms: number, parent?: AbortSignal): AbortSignal {
  if (ms <= 0) return parent ?? new AbortController().signal;
  return combineSignals(parent, AbortSignal.timeout(ms));
}
