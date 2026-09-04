import os from "node:os";
import path from "node:path";

export const PROJECT_PI_DIR = ".pi";
export const PACKAGE_DIR_NAME = "pi-essentials";

export function getAgentDir(): string {
  if (process.env.PI_CODING_AGENT_DIR?.trim()) {
    return process.env.PI_CODING_AGENT_DIR.trim();
  }
  return path.join(os.homedir(), ".pi", "agent");
}

export function getProjectPiDir(cwd: string): string {
  return path.join(cwd, PROJECT_PI_DIR);
}

export function getPiEssentialsDir(): string {
  return path.join(getAgentDir(), PACKAGE_DIR_NAME);
}

export function getUserConfigPath(): string {
  return path.join(getAgentDir(), "pi-essentials.json");
}

export function getProjectConfigPath(cwd: string): string {
  return path.join(getProjectPiDir(cwd), "pi-essentials.json");
}

export function getOAuthStorePath(): string {
  return path.join(getPiEssentialsDir(), "mcp-oauth.json");
}

export function getWebCacheDir(): string {
  return path.join(getPiEssentialsDir(), "web-cache");
}

export function mcpConfigCandidates(cwd: string): string[] {
  const home = os.homedir();
  return [
    path.join(home, ".config", "mcp", "mcp.json"),
    path.join(home, ".agents", "mcp.json"),
    path.join(home, ".agents", "mcp", "mcp.json"),
    path.join(getAgentDir(), "mcp.json"),
    path.join(cwd, ".mcp.json"),
    path.join(getProjectPiDir(cwd), "mcp.json"),
  ];
}
