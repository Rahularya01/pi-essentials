export type McpLifecycle = "lazy" | "eager" | "keep-alive";
export type McpAuth = "bearer" | "oauth";

export interface McpOAuthConfig {
  clientId?: string;
  clientSecret?: string;
  scope?: string;
  redirectUri?: string;
}

export interface McpServerDefinition {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  auth?: McpAuth;
  bearerToken?: string;
  bearerTokenEnv?: string;
  oauth?: McpOAuthConfig;
  lifecycle?: McpLifecycle;
  idleTimeout?: number;
  requestTimeoutMs?: number;
  disabled?: boolean;
  includeTools?: string[];
  excludeTools?: string[];
  toolPrefix?: "server" | "none";
}

export interface McpFileShape {
  mcpServers?: Record<string, McpServerDefinition>;
  settings?: {
    requestTimeoutMs?: number;
    idleTimeout?: number;
  };
}

export interface ResolvedServer {
  name: string;
  definition: McpServerDefinition;
  source: string;
}

export interface CachedTool {
  server: string;
  name: string;
  prefixedName: string;
  description: string;
  inputSchema?: unknown;
}

export type ServerStatus = "idle" | "connecting" | "connected" | "failed" | "needs-auth" | "disabled";

export interface ServerSnapshot {
  name: string;
  status: ServerStatus;
  toolCount: number;
  disabled: boolean;
  transport: "stdio" | "http" | "unknown";
  error?: string;
  source: string;
}
