import { randomUUID } from "node:crypto";
import {
  AgentConfigRepository,
  SandboxAggregate,
  SandboxRepository,
  isValidSandboxName,
  type CreateSandboxData,
  type SandboxSnapshot,
  type UpdateSandboxData,
} from "@agent-relay/domain";
import { inject, injectable } from "inversify";

import { SandboxRuntimeManager } from "../runtime/sandbox/sandbox-runtime-manager.js";

export class InvalidSandboxConfigError extends Error {
  constructor(message: string) {
    super(message);
  }
}

@injectable()
export class SandboxService {
  constructor(
    @inject(SandboxRepository)
    private readonly sandboxes: SandboxRepository,
    @inject(AgentConfigRepository)
    private readonly agents: AgentConfigRepository,
    @inject(SandboxRuntimeManager)
    private readonly runtime: SandboxRuntimeManager,
  ) {}

  async list(): Promise<SandboxSnapshot[]> {
    return this.sandboxes.findAll();
  }

  async getById(id: string): Promise<SandboxSnapshot | null> {
    const aggregate = await this.sandboxes.findById(id);
    return aggregate?.snapshot() ?? null;
  }

  async create(data: CreateSandboxData): Promise<SandboxSnapshot> {
    await this.assertWsTunnelAgent(data.agentId);
    this.assertValid(data);
    const active = (await this.sandboxes.findByAgentId(data.agentId)).filter(
      (sandbox) =>
        sandbox.status === "starting" || sandbox.status === "running",
    );
    if (active.length > 0) {
      throw new InvalidSandboxConfigError(
        "Only one active sandbox is allowed per ACP Remote agent",
      );
    }

    const aggregate = SandboxAggregate.create({
      ...data,
      id: randomUUID(),
    });
    await this.sandboxes.save(aggregate);
    if (data.spec.autoStart) {
      return this.runtime.start(aggregate.id);
    }
    return aggregate.snapshot();
  }

  async update(
    id: string,
    data: UpdateSandboxData,
  ): Promise<SandboxSnapshot | null> {
    const aggregate = await this.sandboxes.findById(id);
    if (!aggregate) {
      return null;
    }
    this.assertValid({
      agentId: aggregate.agentId,
      name: data.name ?? aggregate.name,
      provider: aggregate.provider,
      spec: data.spec ?? aggregate.spec,
    });
    aggregate.update(data);
    await this.sandboxes.save(aggregate);
    return aggregate.snapshot();
  }

  async delete(id: string): Promise<boolean> {
    const aggregate = await this.sandboxes.findById(id);
    if (!aggregate) {
      return false;
    }
    if (
      aggregate.status === "starting" ||
      aggregate.status === "running" ||
      aggregate.status === "stopping"
    ) {
      await this.runtime.stop(id);
    }
    return this.sandboxes.delete(id);
  }

  start(id: string): Promise<SandboxSnapshot> {
    return this.runtime.start(id);
  }

  stop(id: string): Promise<SandboxSnapshot> {
    return this.runtime.stop(id);
  }

  refresh(id: string): Promise<SandboxSnapshot> {
    return this.runtime.refresh(id);
  }

  private assertValid(data: CreateSandboxData): void {
    if (!isValidSandboxName(data.name)) {
      throw new InvalidSandboxConfigError(
        "Sandbox name must use only letters, numbers, dots, underscores, and hyphens",
      );
    }
    if (data.provider !== "aio-sandbox") {
      throw new InvalidSandboxConfigError("Unsupported sandbox provider");
    }
    this.runtime.validateSpec(data.spec);
  }

  private async assertWsTunnelAgent(agentId: string): Promise<void> {
    const aggregate = await this.agents.findById(agentId);
    if (!aggregate) {
      throw new InvalidSandboxConfigError(`Agent ${agentId} not found`);
    }
    if (aggregate.snapshot().protocol !== "ws-tunnel") {
      throw new InvalidSandboxConfigError(
        "Sandbox can only be attached to an ACP Remote agent",
      );
    }
  }
}
