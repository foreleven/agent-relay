import { inject, injectable, optional } from "inversify";

/**
 * Immutable runtime configuration resolved once at process boot.
 *
 * Downstream services consume this snapshot instead of reading environment
 * variables directly so tests and alternate boot modes can override values in
 * one place.
 */
export interface GatewayConfigSnapshot {
  port: number;
  corsOrigin: string;
  clusterMode: boolean;
  redisUrl?: string;
  nodeId: string;
  nodeDisplayName: string;
  runtimeAddress: string;
  bunQueueEnabled: boolean;
  bunQueueHost: string;
  bunQueuePort: number;
  bunQueueToken?: string;
  bunQueueQueueName: string;
  bunQueueWorkerConcurrency: number;
  bunQueuePrefix?: string;
  sandboxAioPsm?: string;
  sandboxAioSandboxId?: string;
  sandboxAioRegion?: string;
  sandboxAioBaseUrl?: string;
  sandboxAioToken?: string;
  sandboxAioUserJwt?: string;
  sandboxAioTimeoutMs: number;
}

export const GatewayConfigOverrides = Symbol.for(
  "system.GatewayConfigOverrides",
);

/**
 * Small wrapper around the resolved config snapshot.
 *
 * Using a class here keeps configuration injectable inside the container while
 * still exposing a plain-object view when code needs to serialize/debug it.
 */
@injectable()
export class GatewayConfigService {
  private readonly snapshot: GatewayConfigSnapshot;

  constructor(
    @inject(GatewayConfigOverrides)
    @optional()
    overrides: Partial<GatewayConfigSnapshot> = {},
  ) {
    this.snapshot = buildGatewayConfig(overrides);
  }

  get port(): number {
    return this.snapshot.port;
  }

  get corsOrigin(): string {
    return this.snapshot.corsOrigin;
  }

  get clusterMode(): boolean {
    return this.snapshot.clusterMode;
  }

  get redisUrl(): string | undefined {
    return this.snapshot.redisUrl;
  }

  get nodeId(): string {
    return this.snapshot.nodeId;
  }

  get nodeDisplayName(): string {
    return this.snapshot.nodeDisplayName;
  }

  get runtimeAddress(): string {
    return this.snapshot.runtimeAddress;
  }

  get bunQueueEnabled(): boolean {
    return this.snapshot.bunQueueEnabled;
  }

  get bunQueueHost(): string {
    return this.snapshot.bunQueueHost;
  }

  get bunQueuePort(): number {
    return this.snapshot.bunQueuePort;
  }

  get bunQueueToken(): string | undefined {
    return this.snapshot.bunQueueToken;
  }

  get bunQueueQueueName(): string {
    return this.snapshot.bunQueueQueueName;
  }

  get bunQueueWorkerConcurrency(): number {
    return this.snapshot.bunQueueWorkerConcurrency;
  }

  get bunQueuePrefix(): string | undefined {
    return this.snapshot.bunQueuePrefix;
  }

  get sandboxAioPsm(): string | undefined {
    return this.snapshot.sandboxAioPsm;
  }

  get sandboxAioSandboxId(): string | undefined {
    return this.snapshot.sandboxAioSandboxId;
  }

  get sandboxAioRegion(): string | undefined {
    return this.snapshot.sandboxAioRegion;
  }

  get sandboxAioBaseUrl(): string | undefined {
    return this.snapshot.sandboxAioBaseUrl;
  }

  get sandboxAioToken(): string | undefined {
    return this.snapshot.sandboxAioToken;
  }

  get sandboxAioUserJwt(): string | undefined {
    return this.snapshot.sandboxAioUserJwt;
  }

  get sandboxAioTimeoutMs(): number {
    return this.snapshot.sandboxAioTimeoutMs;
  }

  toSnapshot(): GatewayConfigSnapshot {
    return { ...this.snapshot };
  }
}

export function buildGatewayConfig(
  overrides: Partial<GatewayConfigSnapshot> = {},
): GatewayConfigSnapshot {
  // Prefer explicit overrides in tests/bootstrap code, then fall back to env.
  const port = overrides.port ?? Number(process.env["PORT"] ?? 7890);
  const runtimeAddress =
    overrides.runtimeAddress ??
    process.env["RUNTIME_ADDRESS"] ??
    `http://localhost:${port}`;
  const nodeId = overrides.nodeId ?? process.env["NODE_ID"] ?? runtimeAddress;

  return {
    port,
    corsOrigin:
      overrides.corsOrigin ??
      process.env["CORS_ORIGIN"] ??
      "http://localhost:3000",
    clusterMode:
      overrides.clusterMode ?? process.env["CLUSTER_MODE"] === "true",
    redisUrl: overrides.redisUrl ?? process.env["REDIS_URL"],
    nodeId,
    nodeDisplayName:
      overrides.nodeDisplayName ??
      process.env["NODE_DISPLAY_NAME"] ??
      "Gateway Node",
    runtimeAddress,
    bunQueueEnabled:
      overrides.bunQueueEnabled ?? process.env["BUNQUEUE_ENABLED"] === "true",
    bunQueueHost:
      overrides.bunQueueHost ?? process.env["BUNQUEUE_HOST"] ?? "localhost",
    bunQueuePort:
      overrides.bunQueuePort ?? Number(process.env["BUNQUEUE_PORT"] ?? 6789),
    bunQueueToken:
      overrides.bunQueueToken ?? normalizeOptional(process.env["BUNQUEUE_TOKEN"]),
    bunQueueQueueName:
      overrides.bunQueueQueueName ??
      process.env["BUNQUEUE_QUEUE"] ??
      "scheduled-jobs",
    bunQueueWorkerConcurrency:
      overrides.bunQueueWorkerConcurrency ??
      Number(process.env["BUNQUEUE_WORKER_CONCURRENCY"] ?? 2),
    bunQueuePrefix:
      overrides.bunQueuePrefix ?? normalizeOptional(process.env["BUNQUEUE_PREFIX"]),
    sandboxAioPsm:
      overrides.sandboxAioPsm ?? normalizeOptional(process.env["SANDBOX_AIO_PSM"]),
    sandboxAioSandboxId:
      overrides.sandboxAioSandboxId ??
      normalizeOptional(process.env["SANDBOX_AIO_SANDBOX_ID"]),
    sandboxAioRegion:
      overrides.sandboxAioRegion ??
      normalizeOptional(process.env["SANDBOX_AIO_REGION"]),
    sandboxAioBaseUrl:
      overrides.sandboxAioBaseUrl ??
      normalizeOptional(process.env["SANDBOX_AIO_BASE_URL"]),
    sandboxAioToken:
      overrides.sandboxAioToken ??
      normalizeOptional(process.env["SANDBOX_AIO_TOKEN"]),
    sandboxAioUserJwt:
      overrides.sandboxAioUserJwt ??
      normalizeOptional(process.env["SANDBOX_AIO_USER_JWT"]),
    sandboxAioTimeoutMs:
      overrides.sandboxAioTimeoutMs ??
      Number(process.env["SANDBOX_AIO_TIMEOUT_MS"] ?? 300_000),
  };
}

function normalizeOptional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}
