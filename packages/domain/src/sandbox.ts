export type SandboxProviderName = "aio-sandbox";

export type SandboxStatus =
  | "draft"
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "failed";

export interface SandboxResources {
  readonly cpu?: number;
  readonly memoryMb?: number;
  readonly diskMb?: number;
}

export interface SandboxEnvVar {
  readonly name: string;
  readonly value?: string;
  readonly secretRef?: string;
}

export interface SandboxWorkspaceSpec {
  readonly path?: string;
}

export interface SandboxScript {
  readonly shell?: "sh" | "bash";
  readonly content: string;
  readonly timeoutMs?: number;
}

export interface SandboxRelaySpec {
  readonly command?: string;
  readonly args?: readonly string[];
  readonly restartPolicy?: "never" | "on-failure" | "always";
}

export interface SandboxSpec {
  readonly image?: string;
  readonly resources?: SandboxResources;
  readonly env?: readonly SandboxEnvVar[];
  readonly workspace?: SandboxWorkspaceSpec;
  readonly initScript?: SandboxScript;
  readonly relay?: SandboxRelaySpec;
  readonly ttlSeconds?: number;
  readonly autoStart?: boolean;
}

export interface SandboxSnapshot {
  readonly id: string;
  readonly agentId: string;
  readonly name: string;
  readonly provider: SandboxProviderName;
  readonly spec: SandboxSpec;
  readonly status: SandboxStatus;
  readonly providerInstanceId?: string;
  readonly lastError?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateSandboxData {
  readonly agentId: string;
  readonly name: string;
  readonly provider: SandboxProviderName;
  readonly spec: SandboxSpec;
}

export interface UpdateSandboxData {
  readonly name?: string;
  readonly spec?: SandboxSpec;
}

export class SandboxAggregate {
  id!: string;
  agentId!: string;
  name!: string;
  provider!: SandboxProviderName;
  spec!: SandboxSpec;
  status!: SandboxStatus;
  providerInstanceId?: string;
  lastError?: string;
  createdAt!: string;
  updatedAt!: string;

  snapshot(): SandboxSnapshot {
    return {
      id: this.id,
      agentId: this.agentId,
      name: this.name,
      provider: this.provider,
      spec: this.spec,
      status: this.status,
      ...(this.providerInstanceId
        ? { providerInstanceId: this.providerInstanceId }
        : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }

  static create(input: CreateSandboxData & { id: string }): SandboxAggregate {
    assertSandboxName(input.name);
    const now = new Date().toISOString();
    return SandboxAggregate.fromSnapshot({
      id: input.id,
      agentId: input.agentId,
      name: input.name,
      provider: input.provider,
      spec: input.spec,
      status: "stopped",
      createdAt: now,
      updatedAt: now,
    });
  }

  static fromSnapshot(snapshot: SandboxSnapshot): SandboxAggregate {
    const aggregate = new SandboxAggregate();
    aggregate.id = snapshot.id;
    aggregate.agentId = snapshot.agentId;
    aggregate.name = snapshot.name;
    aggregate.provider = snapshot.provider;
    aggregate.spec = snapshot.spec;
    aggregate.status = snapshot.status;
    aggregate.providerInstanceId = snapshot.providerInstanceId;
    aggregate.lastError = snapshot.lastError;
    aggregate.createdAt = snapshot.createdAt;
    aggregate.updatedAt = snapshot.updatedAt;
    return aggregate;
  }

  update(changes: UpdateSandboxData): void {
    if (changes.name !== undefined) {
      assertSandboxName(changes.name);
      this.name = changes.name;
    }
    if (changes.spec !== undefined) {
      this.spec = changes.spec;
    }
    this.touch();
  }

  markStarting(): void {
    this.status = "starting";
    this.lastError = undefined;
    this.touch();
  }

  rememberProviderInstance(providerInstanceId: string): void {
    this.providerInstanceId = providerInstanceId;
    this.touch();
  }

  markRunning(providerInstanceId: string): void {
    this.status = "running";
    this.providerInstanceId = providerInstanceId;
    this.lastError = undefined;
    this.touch();
  }

  markStopping(): void {
    this.status = "stopping";
    this.touch();
  }

  markStopped(): void {
    this.status = "stopped";
    this.providerInstanceId = undefined;
    this.touch();
  }

  markFailed(message: string, providerInstanceId?: string): void {
    this.status = "failed";
    this.lastError = message;
    if (providerInstanceId) {
      this.providerInstanceId = providerInstanceId;
    }
    this.touch();
  }

  private touch(): void {
    this.updatedAt = new Date().toISOString();
  }
}

const SANDBOX_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

export function isValidSandboxName(value: string): boolean {
  return (
    SANDBOX_NAME_PATTERN.test(value) &&
    value !== "." &&
    value !== ".."
  );
}

function assertSandboxName(value: string): void {
  if (!isValidSandboxName(value)) {
    throw new Error(
      "Sandbox name must use only letters, numbers, dots, underscores, and hyphens",
    );
  }
}
