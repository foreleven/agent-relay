import test from "node:test";
import assert from "node:assert/strict";
import { AgentConfigAggregate, SandboxAggregate } from "@agent-relay/domain";

import { SandboxTemplateRenderer } from "./template-renderer.js";

test("SandboxTemplateRenderer renders supported variables and redacts relay token", () => {
  const renderer = new SandboxTemplateRenderer();
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
  }).snapshot();
  const sandbox = SandboxAggregate.create({
    id: "sandbox-1",
    agentId: agent.id,
    name: "sandbox-one",
    provider: "aio-sandbox",
    spec: {
      workspace: { path: "/workspace" },
      initScript: {
        content: 'cd "{{workspace.path}}" && echo "{{agent.name}}"',
      },
      env: [
        { name: "RELAY_TOKEN", value: "{{relay.token}}" },
      ],
    },
  }).snapshot();

  const rendered = renderer.render(sandbox.spec, {
    agent,
    sandbox,
    gatewayUrl: "https://gateway.test",
    gatewayWsUrl: "wss://gateway.test/ws/a2a/agent-1",
  });

  assert.equal(
    rendered.spec.initScript?.content,
    'cd "/workspace" && echo "codex-prod"',
  );
  assert.deepEqual(rendered.spec.env, [
    { name: "RELAY_TOKEN", value: "secret-token" },
  ]);
  assert.deepEqual(rendered.secrets, ["secret-token"]);
});

test("SandboxTemplateRenderer rejects unknown variables", () => {
  const renderer = new SandboxTemplateRenderer();
  assert.throws(
    () =>
      renderer.validate({
        initScript: { content: "echo {{unknown.value}}" },
      }),
    /Unsupported sandbox template variable/,
  );
});
