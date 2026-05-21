import { inject, injectable } from "inversify";

import { GatewayConfigService } from "../../bootstrap/config.js";
import type {
  SandboxCreateInput,
  SandboxExecInput,
  SandboxExecResult,
  SandboxProcessHandle,
  SandboxProcessInput,
  SandboxProvider,
  SandboxProviderInstance,
} from "./provider.js";

interface SandboxClientConstructor {
  new (config: Record<string, unknown>): SandboxClientLike;
}

interface SandboxClientLike {
  addRequestHeaders?(headers: Record<string, string>): void;
  createSession(input: Record<string, unknown>): Promise<SandboxSessionLike>;
  getSession?(sessionId: string, sandboxId?: string): Promise<SandboxSessionLike>;
  getSessionInfo?(sandboxId: string, sessionId: string): Promise<unknown>;
  deleteSession?(sessionId: string, sandboxId?: string): Promise<void>;
}

interface SandboxSessionLike {
  sessionId: string;
  sandboxId?: string;
  status?: string;
  getInfo?(): Promise<unknown>;
  delete?(): Promise<void>;
  aio?: {
    shell?: {
      execCommand(input: { command: string }): Promise<unknown>;
    };
  };
}

@injectable()
export class AioSandboxProvider implements SandboxProvider {
  readonly provider = "aio-sandbox" as const;
  private clientPromise: Promise<SandboxClientLike> | null = null;
  private readonly sessions = new Map<string, SandboxSessionLike>();

  constructor(
    @inject(GatewayConfigService)
    private readonly config: GatewayConfigService,
  ) {}

  async create(input: SandboxCreateInput): Promise<SandboxProviderInstance> {
    const client = await this.client();
    const session = await client.createSession({
      ttl: input.ttlSeconds,
      image: input.image,
      envs: Object.fromEntries(
        input.env.map((env) => [env.name, env.value]),
      ),
      metadata: {
        TASK_ID: input.sandboxId,
        USER_NAME: input.name,
      },
      resource_limit: input.resources
        ? {
            cpu_milli: input.resources.cpu
              ? Math.round(input.resources.cpu * 1000)
              : undefined,
            memory_mb: input.resources.memoryMb,
          }
        : undefined,
    });
    this.sessions.set(session.sessionId, session);
    return mapSession(session);
  }

  async start(instanceId: string): Promise<SandboxProviderInstance> {
    return this.get(instanceId);
  }

  async stop(instanceId: string): Promise<SandboxProviderInstance> {
    const session = await this.session(instanceId);
    if (session.delete) {
      await session.delete();
    } else {
      const client = await this.client();
      await client.deleteSession?.(instanceId);
    }
    this.sessions.delete(instanceId);
    return { instanceId, status: "stopped", rawStatus: "deleted" };
  }

  async delete(instanceId: string): Promise<void> {
    await this.stop(instanceId);
  }

  async get(instanceId: string): Promise<SandboxProviderInstance> {
    const session = await this.session(instanceId);
    const info = session.getInfo ? await session.getInfo() : session;
    return mapInfo(instanceId, info);
  }

  async exec(input: SandboxExecInput): Promise<SandboxExecResult> {
    const session = await this.session(input.instanceId);
    if (!session.aio?.shell?.execCommand) {
      throw new Error(
        `Sandbox session ${input.instanceId} does not expose shell exec`,
      );
    }
    const command = commandLine(input.command);
    const result = await session.aio.shell.execCommand({ command });
    if (!result || !isRecord(result)) {
      return { exitCode: 0 };
    }
    const exitCode =
      typeof result["exitCode"] === "number"
        ? result["exitCode"]
        : typeof result["code"] === "number"
          ? result["code"]
          : 0;
    return {
      exitCode,
      ...(typeof result["stdout"] === "string"
        ? { stdout: result["stdout"] }
        : {}),
      ...(typeof result["stderr"] === "string"
        ? { stderr: result["stderr"] }
        : {}),
    };
  }

  async startProcess(input: SandboxProcessInput): Promise<SandboxProcessHandle> {
    const result = await this.exec({
      ...input,
      command: [
        "bash",
        "-lc",
        `${commandLine(input.command)} >/tmp/agent-relay-${Date.now()}.log 2>&1 & echo $!`,
      ],
    });
    if (result.exitCode !== 0) {
      throw new Error(
        result.stderr || `Sandbox process command failed with ${result.exitCode}`,
      );
    }
    const processId = result.stdout?.trim() || `${input.instanceId}:relay`;
    return { processId };
  }

  async stopProcess(): Promise<void> {
    // aio-sandbox process supervision is command/image dependent. The session
    // stop path is the authoritative cleanup for phase 1.
  }

  private async session(instanceId: string): Promise<SandboxSessionLike> {
    const existing = this.sessions.get(instanceId);
    if (existing) return existing;

    const client = await this.client();
    const restored = await client.getSession?.(instanceId, this.providerSandboxId());
    if (restored) {
      this.sessions.set(restored.sessionId, restored);
      return restored;
    }

    const info = await client.getSessionInfo?.(this.providerSandboxId(), instanceId);
    if (!isRecord(info)) {
      throw new Error(`Sandbox session ${instanceId} was not found`);
    }
    const session = {
      sessionId: instanceId,
      sandboxId: this.providerSandboxId(),
      status: typeof info["status"] === "string" ? info["status"] : undefined,
    };
    this.sessions.set(instanceId, session);
    return session;
  }

  private async client(): Promise<SandboxClientLike> {
    if (!this.clientPromise) {
      this.clientPromise = this.createClient();
    }
    return this.clientPromise;
  }

  private async createClient(): Promise<SandboxClientLike> {
    const imported = await importByName("@byted/sandbox-sdk").catch((err) => {
      throw new Error(
        `aio-sandbox SDK is unavailable. Install @byted/sandbox-sdk to start managed sandboxes. ${messageOf(err)}`,
      );
    });
    const ctor = readConstructor(imported);
    const client = new ctor({
      ...(this.config.sandboxAioPsm ? { psm: this.config.sandboxAioPsm } : {}),
      ...(this.config.sandboxAioSandboxId
        ? { sandboxId: this.config.sandboxAioSandboxId }
        : {}),
      ...(this.config.sandboxAioRegion
        ? { region: this.config.sandboxAioRegion }
        : {}),
      ...(this.config.sandboxAioBaseUrl
        ? { baseUrl: this.config.sandboxAioBaseUrl }
        : {}),
      timeout: this.config.sandboxAioTimeoutMs,
      ...(this.config.sandboxAioToken
        ? { token: this.config.sandboxAioToken }
        : {}),
    });
    if (this.config.sandboxAioUserJwt) {
      client.addRequestHeaders?.({
        "X-User-Jwt-Token": this.config.sandboxAioUserJwt,
      });
    }
    return client;
  }

  private providerSandboxId(): string {
    return this.config.sandboxAioSandboxId ?? "";
  }
}

function commandLine(parts: readonly string[]): string {
  return parts.map(shellQuote).join(" ");
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function mapSession(session: SandboxSessionLike): SandboxProviderInstance {
  return mapInfo(session.sessionId, session);
}

function mapInfo(instanceId: string, value: unknown): SandboxProviderInstance {
  const rawStatus =
    isRecord(value) && typeof value["status"] === "string"
      ? value["status"]
      : undefined;
  return {
    instanceId,
    status: normalizeStatus(rawStatus),
    ...(rawStatus ? { rawStatus } : {}),
  };
}

function normalizeStatus(
  value: string | undefined,
): SandboxProviderInstance["status"] {
  if (value === "running" || value === "active") return "running";
  if (value === "pending") return "pending";
  if (value === "expired" || value === "deleted") return "stopped";
  return value ? "failed" : "running";
}

function readConstructor(moduleValue: unknown): SandboxClientConstructor {
  if (isRecord(moduleValue) && typeof moduleValue["SandboxClient"] === "function") {
    return moduleValue["SandboxClient"] as SandboxClientConstructor;
  }
  throw new Error("@byted/sandbox-sdk did not export SandboxClient");
}

function importByName(specifier: string): Promise<unknown> {
  const importer = new Function("specifier", "return import(specifier);") as (
    value: string,
  ) => Promise<unknown>;
  return importer(specifier);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
