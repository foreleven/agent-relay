import {
  AgentConfigRepository,
  SandboxRepository,
  type AgentConfigSnapshot,
  type SandboxSnapshot,
  type SandboxSpec,
  type WsTunnelAgentConfig,
} from "@agent-relay/domain";
import { inject, injectable } from "inversify";

import { GatewayConfigService } from "../../bootstrap/config.js";
import { WsTunnelConnectionRegistry } from "../ws-tunnel-registry.js";
import {
  SandboxProvider,
  type ResolvedSandboxEnvVar,
  type SandboxProvider as SandboxProviderPort,
} from "./provider.js";
import { SandboxTemplateRenderer } from "./template-renderer.js";

export interface SandboxRuntimeEvent {
  readonly type: "snapshot" | "status" | "log" | "relay-connected" | "error-state";
  readonly data: unknown;
  readonly createdAt: string;
}

type SandboxEventListener = (event: SandboxRuntimeEvent) => void;

@injectable()
export class SandboxRuntimeManager {
  private readonly renderer = new SandboxTemplateRenderer();
  private readonly history = new Map<string, SandboxRuntimeEvent[]>();
  private readonly listeners = new Map<string, Set<SandboxEventListener>>();
  private readonly startLocks = new Map<string, Promise<void>>();

  constructor(
    @inject(SandboxRepository)
    private readonly sandboxes: SandboxRepository,
    @inject(AgentConfigRepository)
    private readonly agents: AgentConfigRepository,
    @inject(SandboxProvider)
    private readonly provider: SandboxProviderPort,
    @inject(GatewayConfigService)
    private readonly config: GatewayConfigService,
    @inject(WsTunnelConnectionRegistry)
    private readonly wsTunnel: WsTunnelConnectionRegistry,
  ) {}

  validateSpec(spec: SandboxSpec): void {
    this.renderer.validate(spec);
  }

  async start(sandboxId: string): Promise<SandboxSnapshot> {
    const initial = await this.requireSandbox(sandboxId);
    return this.withAgentStartLock(initial.agentId, () =>
      this.startLocked(sandboxId),
    );
  }

  private async startLocked(sandboxId: string): Promise<SandboxSnapshot> {
    const aggregate = await this.requireSandbox(sandboxId);
    if (aggregate.status === "running") {
      if (!aggregate.providerInstanceId) {
        aggregate.markFailed("Running sandbox is missing provider instance id");
        await this.sandboxes.save(aggregate);
      } else {
        const existing = await this.provider
          .get(aggregate.providerInstanceId)
          .catch(() => null);
        if (existing && isActiveProviderInstance(existing.status)) {
          return aggregate.snapshot();
        }
      }
    }

    const agent = await this.requireWsTunnelAgent(aggregate.agentId);
    await this.assertNoOtherActiveSandbox(aggregate.snapshot());
    aggregate.markStarting();
    await this.sandboxes.save(aggregate);
    this.publish(aggregate.id, "status", aggregate.snapshot());

    try {
      const rendered = this.renderer.render(aggregate.spec, {
        agent,
        sandbox: aggregate.snapshot(),
        gatewayUrl: this.gatewayHttpUrl(),
        gatewayWsUrl: this.gatewayWsUrl(agent.id),
      });
      const providerInstance = await this.resolveProviderInstance(
        aggregate.snapshot(),
        rendered.spec,
        agent,
      );
      aggregate.rememberProviderInstance(providerInstance.instanceId);
      await this.sandboxes.save(aggregate);

      if (rendered.spec.initScript?.content.trim()) {
        const init = rendered.spec.initScript;
        const result = await this.provider.exec({
          instanceId: providerInstance.instanceId,
          command: [
            init.shell ?? "bash",
            "-lc",
            init.content,
          ],
          cwd: rendered.spec.workspace?.path,
          timeoutMs: init.timeoutMs,
          redact: rendered.secrets,
        });
        if (result.stdout) {
          this.publish(aggregate.id, "log", {
            stream: "stdout",
            text: redact(result.stdout, rendered.secrets),
          });
        }
        if (result.stderr) {
          this.publish(aggregate.id, "log", {
            stream: "stderr",
            text: redact(result.stderr, rendered.secrets),
          });
        }
        if (result.exitCode !== 0) {
          throw new Error(
            result.stderr || `init script failed with exit code ${result.exitCode}`,
          );
        }
      }

      await this.provider.startProcess({
        instanceId: providerInstance.instanceId,
        command: this.relayCommand(rendered.spec, agent),
        cwd: rendered.spec.workspace?.path,
        env: this.resolveEnv(rendered.spec, agent),
        restartPolicy: rendered.spec.relay?.restartPolicy ?? "always",
        redact: rendered.secrets,
      });

      aggregate.markRunning(providerInstance.instanceId);
      await this.sandboxes.save(aggregate);
      this.publish(aggregate.id, "status", aggregate.snapshot());
      if (this.wsTunnel.isConnected(agent.id)) {
        this.publish(aggregate.id, "relay-connected", {
          agentId: agent.id,
          connectedAt: new Date().toISOString(),
        });
      }
      return aggregate.snapshot();
    } catch (err) {
      aggregate.markFailed(messageOf(err), aggregate.providerInstanceId);
      await this.sandboxes.save(aggregate);
      this.publish(aggregate.id, "error-state", { message: messageOf(err) });
      this.publish(aggregate.id, "status", aggregate.snapshot());
      return aggregate.snapshot();
    }
  }

  private async resolveProviderInstance(
    sandbox: SandboxSnapshot,
    spec: SandboxSpec,
    agent: AgentConfigSnapshot,
  ) {
    if (sandbox.providerInstanceId) {
      const existing = await this.provider
        .get(sandbox.providerInstanceId)
        .catch(() => null);
      if (existing && isActiveProviderInstance(existing.status)) {
        return existing;
      }
    }

    return this.provider.create({
      sandboxId: sandbox.id,
      name: sandbox.name,
      image: spec.image,
      resources: spec.resources,
      env: this.resolveEnv(spec, agent),
      ttlSeconds: spec.ttlSeconds,
    });
  }

  async stop(sandboxId: string): Promise<SandboxSnapshot> {
    const aggregate = await this.requireSandbox(sandboxId);
    if (aggregate.status === "stopped") {
      return aggregate.snapshot();
    }
    aggregate.markStopping();
    await this.sandboxes.save(aggregate);
    this.publish(aggregate.id, "status", aggregate.snapshot());

    try {
      if (aggregate.providerInstanceId) {
        await this.provider.stop(aggregate.providerInstanceId);
      }
      aggregate.markStopped();
      await this.sandboxes.save(aggregate);
      this.publish(aggregate.id, "status", aggregate.snapshot());
      return aggregate.snapshot();
    } catch (err) {
      aggregate.markFailed(messageOf(err), aggregate.providerInstanceId);
      await this.sandboxes.save(aggregate);
      this.publish(aggregate.id, "error-state", { message: messageOf(err) });
      this.publish(aggregate.id, "status", aggregate.snapshot());
      return aggregate.snapshot();
    }
  }

  async refresh(sandboxId: string): Promise<SandboxSnapshot> {
    const aggregate = await this.requireSandbox(sandboxId);
    if (!aggregate.providerInstanceId) {
      return aggregate.snapshot();
    }
    const instance = await this.provider.get(aggregate.providerInstanceId);
    if (instance.status === "running") {
      aggregate.markRunning(instance.instanceId);
    } else if (instance.status === "stopped") {
      aggregate.markStopped();
    } else if (instance.status === "failed") {
      aggregate.markFailed(`Provider status: ${instance.rawStatus ?? "failed"}`);
    }
    await this.sandboxes.save(aggregate);
    this.publish(aggregate.id, "status", aggregate.snapshot());
    return aggregate.snapshot();
  }

  subscribe(
    sandboxId: string,
    listener: SandboxEventListener,
  ): () => void {
    const set = this.listeners.get(sandboxId) ?? new Set<SandboxEventListener>();
    set.add(listener);
    this.listeners.set(sandboxId, set);
    for (const event of this.history.get(sandboxId) ?? []) {
      listener(event);
    }
    return () => {
      set.delete(listener);
      if (set.size === 0) {
        this.listeners.delete(sandboxId);
      }
    };
  }

  private async requireSandbox(sandboxId: string) {
    const aggregate = await this.sandboxes.findById(sandboxId);
    if (!aggregate) {
      throw new Error(`Sandbox ${sandboxId} not found`);
    }
    return aggregate;
  }

  private async requireWsTunnelAgent(agentId: string): Promise<AgentConfigSnapshot> {
    const aggregate = await this.agents.findById(agentId);
    if (!aggregate) {
      throw new Error(`Agent ${agentId} not found`);
    }
    const agent = aggregate.snapshot();
    if (agent.protocol !== "ws-tunnel") {
      throw new Error("Sandbox can only run ACP Remote agents");
    }
    return agent;
  }

  private async assertNoOtherActiveSandbox(
    current: SandboxSnapshot,
  ): Promise<void> {
    const active = (await this.sandboxes.findByAgentId(current.agentId)).find(
      (sandbox) =>
        sandbox.id !== current.id &&
        (sandbox.status === "starting" || sandbox.status === "running"),
    );
    if (active) {
      throw new Error(
        `Agent ${current.agentId} already has active sandbox ${active.id}`,
      );
    }
  }

  private async withAgentStartLock<T>(
    agentId: string,
    action: () => Promise<T>,
  ): Promise<T> {
    const previous = this.startLocks.get(agentId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.startLocks.set(agentId, current);
    await previous.catch(() => undefined);
    try {
      return await action();
    } finally {
      release();
      if (this.startLocks.get(agentId) === current) {
        this.startLocks.delete(agentId);
      }
    }
  }

  private resolveEnv(
    spec: SandboxSpec,
    agent: AgentConfigSnapshot,
  ): ResolvedSandboxEnvVar[] {
    const cfg = agent.config as WsTunnelAgentConfig;
    const base: ResolvedSandboxEnvVar[] = [
      { name: "RELAY_GATEWAY_URL", value: this.gatewayHttpUrl(), secret: false },
      { name: "RELAY_TOKEN", value: cfg.relayToken, secret: true },
    ];
    const extra = (spec.env ?? []).map((env): ResolvedSandboxEnvVar => ({
      name: env.name,
      value: env.value ?? readSecretRef(env.secretRef) ?? "",
      secret: Boolean(env.secretRef || env.name.includes("TOKEN")),
    }));
    return [...base, ...extra];
  }

  private relayCommand(
    spec: SandboxSpec,
    agent: AgentConfigSnapshot,
  ): readonly string[] {
    const relay = spec.relay;
    return [
      relay?.command ?? "relay",
      ...(relay?.args ?? [
        "serve",
        agent.id,
        "--gateway-url",
        this.gatewayHttpUrl(),
      ]),
    ];
  }

  private gatewayHttpUrl(): string {
    return /^https?:\/\//i.test(this.config.runtimeAddress)
      ? this.config.runtimeAddress.replace(/\/$/, "")
      : `http://${this.config.runtimeAddress}`.replace(/\/$/, "");
  }

  private gatewayWsUrl(agentId: string): string {
    const parsed = new URL(this.gatewayHttpUrl());
    parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
    return `${parsed.href.replace(/\/$/, "")}/ws/a2a/${agentId}`;
  }

  private publish(
    sandboxId: string,
    type: SandboxRuntimeEvent["type"],
    data: unknown,
  ): void {
    const event = { type, data, createdAt: new Date().toISOString() };
    const events = [...(this.history.get(sandboxId) ?? []), event].slice(-100);
    this.history.set(sandboxId, events);
    for (const listener of this.listeners.get(sandboxId) ?? []) {
      listener(event);
    }
  }
}

function readSecretRef(secretRef: string | undefined): string | undefined {
  return secretRef ? process.env[secretRef] : undefined;
}

function isActiveProviderInstance(status: "pending" | "running" | "stopped" | "failed"): boolean {
  return status === "pending" || status === "running";
}

function redact(value: string, secrets: readonly string[]): string {
  return secrets.reduce(
    (text, secret) => text.replaceAll(secret, "[redacted]"),
    value,
  );
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
