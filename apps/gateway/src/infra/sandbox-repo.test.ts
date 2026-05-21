import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { SandboxAggregate } from "@agent-relay/domain";

import { prisma } from "../store/prisma.js";
import { SandboxStateRepository } from "./sandbox-repo.js";

test("SandboxStateRepository clears nullable lifecycle fields", async () => {
  const repo = new SandboxStateRepository();
  const agentId = randomUUID();
  const sandboxId = randomUUID();

  await prisma.agent.create({
    data: {
      id: agentId,
      name: `agent-${agentId}`,
      protocol: "ws-tunnel",
      config: JSON.stringify({
        transport: "ws-tunnel",
        relayToken: "token",
        executor: { type: "codex", command: "npx" },
      }),
    },
  });

  const aggregate = SandboxAggregate.create({
    id: sandboxId,
    agentId,
    name: `sandbox-${sandboxId}`,
    provider: "aio-sandbox",
    spec: {},
  });

  aggregate.markFailed("setup failed", "provider-session-1");
  await repo.save(aggregate);

  aggregate.markRunning("provider-session-1");
  await repo.save(aggregate);
  const running = await repo.findById(sandboxId);
  assert.equal(running?.snapshot().lastError, undefined);

  aggregate.markStopped();
  await repo.save(aggregate);
  const stopped = await repo.findById(sandboxId);
  assert.equal(stopped?.snapshot().providerInstanceId, undefined);
});
