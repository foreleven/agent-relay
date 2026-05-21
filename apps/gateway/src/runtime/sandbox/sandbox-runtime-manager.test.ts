import test from "node:test";
import assert from "node:assert/strict";
import {
  AgentConfigAggregate,
  SandboxAggregate,
  type AgentConfigRepository,
  type SandboxRepository,
} from "@agent-relay/domain";

import { GatewayConfigService } from "../../bootstrap/config.js";
import { WsTunnelConnectionRegistry } from "../ws-tunnel-registry.js";
import {
  type SandboxCreateInput,
  type SandboxExecResult,
  type SandboxProcessHandle,
  type SandboxProcessInput,
  type SandboxProvider,
  type SandboxProviderInstance,
} from "./provider.js";
import { SandboxRuntimeManager } from "./sandbox-runtime-manager.js";

test("SandboxRuntimeManager starts sandbox by creating, running init, then starting relay", async () => {
  const agent = AgentConfigAggregate.fromSnapshot({
    id: "agent-1",
    name: "codex-prod",
    protocol: "ws-tunnel",
    config: {
      transport: "ws-tunnel",
      relayToken: "secret-token",
      executor: {
        type: "codex",
        command: "npx",
        args: ["@zed-industries/codex-acp"],
      },
    },
    createdAt: "2026-05-19T00:00:00.000Z",
  });
  const sandbox = SandboxAggregate.create({
    id: "sandbox-1",
    agentId: "agent-1",
    name: "sandbox-one",
    provider: "aio-sandbox",
    spec: {
      workspace: { path: "/workspace" },
      initScript: { content: "pnpm install", shell: "bash" },
      relay: { command: "relay", restartPolicy: "always" },
    },
  });
  const sandboxes = new MemorySandboxRepository([sandbox]);
  const provider = new RecordingSandboxProvider();
  const manager = new SandboxRuntimeManager(
    sandboxes,
    new MemoryAgentRepository([agent]),
    provider,
    new GatewayConfigService({ runtimeAddress: "https://gateway.test" }),
    new WsTunnelConnectionRegistry(),
  );

  const started = await manager.start("sandbox-1");

  assert.equal(started.status, "running");
  assert.equal(started.providerInstanceId, "session-sandbox-1");
  assert.deepEqual(provider.calls.map((call) => call.kind), [
    "create",
    "exec",
    "startProcess",
  ]);
  assert.deepEqual(provider.processCommands[0], [
    "relay",
    "serve",
    "agent-1",
    "--gateway-url",
    "https://gateway.test",
  ]);
});

test("SandboxRuntimeManager preserves provider instance when init fails so stop can clean it up", async () => {
  const agent = createWsTunnelAgent();
  const sandbox = createSandbox("sandbox-1", "agent-1", {
    initScript: { content: "exit 1", shell: "bash" },
  });
  const sandboxes = new MemorySandboxRepository([sandbox]);
  const provider = new RecordingSandboxProvider();
  provider.execResult = { exitCode: 1, stderr: "install failed" };
  const manager = createManager(sandboxes, [agent], provider);

  const failed = await manager.start("sandbox-1");

  assert.equal(failed.status, "failed");
  assert.equal(failed.providerInstanceId, "session-sandbox-1");

  const stopped = await manager.stop("sandbox-1");
  assert.equal(stopped.status, "stopped");
  assert.deepEqual(provider.calls.map((call) => call.kind), [
    "create",
    "exec",
    "stop",
  ]);
});

test("SandboxRuntimeManager rejects starting a second active sandbox for one agent", async () => {
  const agent = createWsTunnelAgent();
  const active = createSandbox("sandbox-1", "agent-1", {});
  active.markRunning("provider-session-1");
  const stopped = createSandbox("sandbox-2", "agent-1", {});
  const provider = new RecordingSandboxProvider();
  const manager = createManager(
    new MemorySandboxRepository([active, stopped]),
    [agent],
    provider,
  );

  await assert.rejects(
    () => manager.start("sandbox-2"),
    /already has active sandbox sandbox-1/,
  );
  assert.deepEqual(provider.calls, []);
});

test("SandboxRuntimeManager recreates provider session when stored session is expired", async () => {
  const agent = createWsTunnelAgent();
  const sandbox = createSandbox("sandbox-1", "agent-1", {});
  sandbox.rememberProviderInstance("expired-session");
  const provider = new RecordingSandboxProvider();
  provider.instances.set("expired-session", { status: "stopped" });
  const manager = createManager(
    new MemorySandboxRepository([sandbox]),
    [agent],
    provider,
  );

  const started = await manager.start("sandbox-1");

  assert.equal(started.status, "running");
  assert.equal(started.providerInstanceId, "session-sandbox-1");
  assert.deepEqual(provider.calls.map((call) => call.kind), [
    "get",
    "create",
    "startProcess",
  ]);
});

test("SandboxRuntimeManager reuses active provider session when restarting failed setup", async () => {
  const agent = createWsTunnelAgent();
  const sandbox = createSandbox("sandbox-1", "agent-1", {});
  sandbox.markFailed("previous setup failed", "server-session-1");
  const provider = new RecordingSandboxProvider();
  provider.instances.set("server-session-1", { status: "running" });
  const manager = createManager(
    new MemorySandboxRepository([sandbox]),
    [agent],
    provider,
  );

  const started = await manager.start("sandbox-1");

  assert.equal(started.status, "running");
  assert.equal(started.providerInstanceId, "server-session-1");
  assert.deepEqual(provider.calls.map((call) => call.kind), [
    "get",
    "startProcess",
  ]);
});

test("SandboxRuntimeManager serializes concurrent starts for the same agent", async () => {
  const agent = createWsTunnelAgent();
  const first = createSandbox("sandbox-1", "agent-1", {});
  const second = createSandbox("sandbox-2", "agent-1", {});
  const provider = new RecordingSandboxProvider();
  const manager = createManager(
    new MemorySandboxRepository([first, second]),
    [agent],
    provider,
  );

  const results = await Promise.allSettled([
    manager.start("sandbox-1"),
    manager.start("sandbox-2"),
  ]);

  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(
    results.filter((result) => result.status === "rejected").length,
    1,
  );
  assert.equal(
    provider.calls.filter((call) => call.kind === "create").length,
    1,
  );
});

class MemoryAgentRepository implements AgentConfigRepository {
  private readonly agents = new Map<string, AgentConfigAggregate>();

  constructor(agents: AgentConfigAggregate[]) {
    for (const agent of agents) {
      this.agents.set(agent.id, agent);
    }
  }

  async findById(id: string): Promise<AgentConfigAggregate | null> {
    return this.agents.get(id) ?? null;
  }

  async findAll() {
    return [...this.agents.values()].map((agent) => agent.snapshot());
  }

  async save(aggregate: AgentConfigAggregate): Promise<void> {
    this.agents.set(aggregate.id, aggregate);
  }
}

class MemorySandboxRepository implements SandboxRepository {
  private readonly sandboxes = new Map<string, SandboxAggregate>();

  constructor(sandboxes: SandboxAggregate[]) {
    for (const sandbox of sandboxes) {
      this.sandboxes.set(sandbox.id, sandbox);
    }
  }

  async findById(id: string): Promise<SandboxAggregate | null> {
    return this.sandboxes.get(id) ?? null;
  }

  async findAll() {
    return [...this.sandboxes.values()].map((sandbox) => sandbox.snapshot());
  }

  async findByAgentId(agentId: string) {
    return [...this.sandboxes.values()]
      .map((sandbox) => sandbox.snapshot())
      .filter((sandbox) => sandbox.agentId === agentId);
  }

  async save(aggregate: SandboxAggregate): Promise<void> {
    this.sandboxes.set(aggregate.id, aggregate);
  }

  async delete(id: string): Promise<boolean> {
    return this.sandboxes.delete(id);
  }
}

class RecordingSandboxProvider implements SandboxProvider {
  readonly provider = "aio-sandbox" as const;
  readonly calls: Array<{ kind: string }> = [];
  readonly processCommands: string[][] = [];
  readonly instances = new Map<string, { status: SandboxProviderInstance["status"] }>();
  execResult: SandboxExecResult = { exitCode: 0, stdout: "ok" };

  async create(input: SandboxCreateInput): Promise<SandboxProviderInstance> {
    this.calls.push({ kind: "create" });
    const instanceId = `session-${input.sandboxId}`;
    this.instances.set(instanceId, { status: "running" });
    return { instanceId, status: "running" };
  }

  async start(instanceId: string): Promise<SandboxProviderInstance> {
    this.calls.push({ kind: "start" });
    return { instanceId, status: "running" };
  }

  async stop(instanceId: string): Promise<SandboxProviderInstance> {
    this.calls.push({ kind: "stop" });
    this.instances.set(instanceId, { status: "stopped" });
    return { instanceId, status: "stopped" };
  }

  async delete(): Promise<void> {
    this.calls.push({ kind: "delete" });
  }

  async get(instanceId: string): Promise<SandboxProviderInstance> {
    this.calls.push({ kind: "get" });
    const instance = this.instances.get(instanceId);
    if (!instance) {
      throw new Error(`Session ${instanceId} not found`);
    }
    return { instanceId, status: instance.status };
  }

  async exec(): Promise<SandboxExecResult> {
    this.calls.push({ kind: "exec" });
    return this.execResult;
  }

  async startProcess(input: SandboxProcessInput): Promise<SandboxProcessHandle> {
    this.calls.push({ kind: "startProcess" });
    this.processCommands.push([...input.command]);
    return { processId: "relay-1" };
  }

  async stopProcess(): Promise<void> {
    this.calls.push({ kind: "stopProcess" });
  }
}

function createWsTunnelAgent(): AgentConfigAggregate {
  return AgentConfigAggregate.fromSnapshot({
    id: "agent-1",
    name: "codex-prod",
    protocol: "ws-tunnel",
    config: {
      transport: "ws-tunnel",
      relayToken: "secret-token",
      executor: {
        type: "codex",
        command: "npx",
        args: ["@zed-industries/codex-acp"],
      },
    },
    createdAt: "2026-05-19T00:00:00.000Z",
  });
}

function createSandbox(
  id: string,
  agentId: string,
  spec: Parameters<typeof SandboxAggregate.create>[0]["spec"],
): SandboxAggregate {
  return SandboxAggregate.create({
    id,
    agentId,
    name: id,
    provider: "aio-sandbox",
    spec,
  });
}

function createManager(
  sandboxes: SandboxRepository,
  agents: AgentConfigAggregate[],
  provider: SandboxProvider,
): SandboxRuntimeManager {
  return new SandboxRuntimeManager(
    sandboxes,
    new MemoryAgentRepository(agents),
    provider,
    new GatewayConfigService({ runtimeAddress: "https://gateway.test" }),
    new WsTunnelConnectionRegistry(),
  );
}
