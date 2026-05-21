import type { SandboxProviderName, SandboxResources } from "@agent-relay/domain";

export const SandboxProvider = Symbol.for("runtime.SandboxProvider");

export interface ResolvedSandboxEnvVar {
  readonly name: string;
  readonly value: string;
  readonly secret: boolean;
}

export interface SandboxProviderInstance {
  readonly instanceId: string;
  readonly status: "pending" | "running" | "stopped" | "failed";
  readonly rawStatus?: string;
}

export interface SandboxExecInput {
  readonly instanceId: string;
  readonly command: readonly string[];
  readonly cwd?: string;
  readonly env?: readonly ResolvedSandboxEnvVar[];
  readonly timeoutMs?: number;
  readonly redact?: readonly string[];
}

export interface SandboxExecResult {
  readonly exitCode: number;
  readonly stdout?: string;
  readonly stderr?: string;
}

export interface SandboxCreateInput {
  readonly sandboxId: string;
  readonly name: string;
  readonly image?: string;
  readonly resources?: SandboxResources;
  readonly env: readonly ResolvedSandboxEnvVar[];
  readonly ttlSeconds?: number;
}

export interface SandboxProcessInput extends SandboxExecInput {
  readonly restartPolicy: "never" | "on-failure" | "always";
}

export interface SandboxProcessHandle {
  readonly processId: string;
}

export interface SandboxProvider {
  readonly provider: SandboxProviderName;
  create(input: SandboxCreateInput): Promise<SandboxProviderInstance>;
  start(instanceId: string): Promise<SandboxProviderInstance>;
  stop(instanceId: string): Promise<SandboxProviderInstance>;
  delete(instanceId: string): Promise<void>;
  get(instanceId: string): Promise<SandboxProviderInstance>;
  exec(input: SandboxExecInput): Promise<SandboxExecResult>;
  startProcess(input: SandboxProcessInput): Promise<SandboxProcessHandle>;
  stopProcess(input: { instanceId: string; processId: string }): Promise<void>;
}
