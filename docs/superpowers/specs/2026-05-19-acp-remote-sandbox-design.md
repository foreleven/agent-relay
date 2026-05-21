# ACP Remote Sandbox Design

## Goal

Add a sandbox capability for ACP Remote agents so AgentRelay can provision and
operate the environment that runs `relay serve <agent-id>` and the configured
ACP executor, while keeping the concrete sandbox provider behind a clean
infrastructure adapter.

The first provider implementation is `aio-sandbox`. The gateway must not couple
domain or application services to `aio-sandbox` request/response shapes because
the long-term implementation is a cloud service boundary.

Required capabilities:

1. Execute an initialization script in the sandbox before the relay process
   starts. This script must support variable substitution so operators can pull
   code, install dependencies, export credentials, and start from a known
   workspace shape.
2. Start and stop a sandbox for an ACP Remote agent.
3. Support sandbox management in the admin UI.

## Non-goals

- Do not replace the existing `ws-tunnel` protocol. Sandbox-managed agents still
  connect back to `GET /ws/a2a/:agentId` through the relay CLI.
- Do not make channel monitor ownership depend on sandbox lifecycle. Channel
  binding reconciliation remains owned by runtime assignment services.
- Do not expose provider-native IDs or credentials as the primary public model.
- Do not run ad hoc database migrations; Prisma migrations remain the source of
  truth for persisted tables.

## Current Context

ACP Remote is currently represented as:

- `AgentConfigSnapshot.protocol = "ws-tunnel"`
- `WsTunnelAgentConfig.transport = "ws-tunnel"`
- `WsTunnelAgentConfig.executor` describes the local ACP stdio command.
- `relay serve <agent-id>` fetches `/api/agents/:id/runner-config`, starts the
  executor, and keeps a WebSocket tunnel connected to the gateway.

Today an operator runs the relay CLI on their own host. The sandbox feature
turns that host into a managed runtime owned by AgentRelay or by a cloud service
behind AgentRelay.

## Design Summary

Introduce a sandbox bounded context next to the agent-management context:

```text
Admin UI
  -> Sandbox HTTP API
  -> SandboxApplicationService
  -> SandboxAggregate / SandboxRepository
  -> SandboxRuntimeManager
  -> SandboxProvider port
  -> AioSandboxProvider adapter
  -> managed sandbox instance
       -> init script
       -> relay serve <agent-id>
       -> gateway ws-tunnel
```

The sandbox lifecycle is intentionally separate from `AgentTransport`. A
transport sends one request to an agent; a sandbox is a long-lived runtime
resource that prepares the environment and hosts the relay CLI.

## Domain Model

### `SandboxAggregate`

`packages/domain/src/aggregates/sandbox.ts`

Fields:

```ts
export type SandboxStatus =
  | "draft"
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "failed";

export interface SandboxSnapshot {
  readonly id: string;
  readonly agentId: string;
  readonly name: string;
  readonly provider: "aio-sandbox";
  readonly spec: SandboxSpec;
  readonly status: SandboxStatus;
  readonly providerInstanceId?: string;
  readonly lastError?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}
```

Invariants:

- `agentId` must reference an existing `ws-tunnel` agent.
- One active sandbox per agent for phase 1. This avoids duplicate relay
  connections because `WsTunnelConnectionRegistry` keeps one live connection per
  `agentId`.
- `providerInstanceId` is stored only after provider creation succeeds.
- Terminal provider errors transition the aggregate to `failed` with a concise
  operator-facing `lastError`.

### `SandboxSpec`

`SandboxSpec` is provider-neutral:

```ts
export interface SandboxSpec {
  readonly image?: string;
  readonly resources?: {
    readonly cpu?: number;
    readonly memoryMb?: number;
    readonly diskMb?: number;
  };
  readonly env?: readonly SandboxEnvVar[];
  readonly workspace?: {
    readonly path?: string;
  };
  readonly initScript?: SandboxScript;
  readonly relay?: SandboxRelaySpec;
  readonly ttlSeconds?: number;
  readonly autoStart?: boolean;
}

export interface SandboxEnvVar {
  readonly name: string;
  readonly value?: string;
  readonly secretRef?: string;
}

export interface SandboxScript {
  readonly shell: "sh" | "bash";
  readonly content: string;
  readonly timeoutMs?: number;
}

export interface SandboxRelaySpec {
  readonly command?: string;
  readonly args?: readonly string[];
  readonly restartPolicy?: "never" | "on-failure" | "always";
}
```

Defaults:

- `workspace.path`: `/workspace`
- `initScript.shell`: `bash`
- `relay.command`: `relay`
- `relay.args`: `["serve", "{{agent.id}}", "--gateway-url", "{{gateway.url}}"]`
- `relay.restartPolicy`: `always`

## Template Variables

Variable substitution must be explicit and typed. Do not pass arbitrary process
environment into templates.

Supported variables for phase 1:

| Variable | Meaning |
|---|---|
| `{{agent.id}}` | Gateway agent id |
| `{{agent.name}}` | Folder-safe agent name |
| `{{agent.executor.type}}` | `claude-code` or `codex` |
| `{{gateway.url}}` | Public gateway HTTP URL |
| `{{gateway.wsUrl}}` | Public gateway WebSocket URL for the agent |
| `{{relay.token}}` | Relay token, injected as a secret value |
| `{{sandbox.id}}` | Gateway sandbox id |
| `{{workspace.path}}` | Effective workspace directory |

Rendering rules:

- Use a small `SandboxTemplateRenderer` class rather than ad hoc string
  replacements throughout the codebase.
- Unknown variables fail validation before provider calls.
- Secret variables are allowed in env and process launch configuration, but they
  must be redacted from logs, API responses, and SSE events.
- Rendered scripts are persisted only if they contain no secret variables. If a
  script references a secret, persist the template and provider execution id
  instead.

Example initialization script:

```bash
set -euo pipefail
mkdir -p "{{workspace.path}}"
cd "{{workspace.path}}"
git clone https://github.com/example/project.git repo
cd repo
pnpm install --frozen-lockfile
```

Example relay environment:

```text
RELAY_GATEWAY_URL={{gateway.url}}
RELAY_TOKEN={{relay.token}}
```

## Application Services

### `SandboxApplicationService`

Responsibilities:

- create/update/delete sandbox definitions
- validate that `agentId` points to a `ws-tunnel` agent
- validate scripts, variables, resource limits, and provider selection
- start and stop sandboxes by delegating to `SandboxRuntimeManager`
- expose redacted sandbox snapshots for HTTP/UI
- publish `SandboxChanged` events for UI refresh and cluster coordination

It depends on repository ports and runtime ports, not on provider SDKs.

### `SandboxRuntimeManager`

Runtime-facing OOP service:

- `start(sandboxId): Promise<SandboxSnapshot>`
- `stop(sandboxId): Promise<SandboxSnapshot>`
- `refresh(sandboxId): Promise<SandboxSnapshot>`
- `streamEvents(sandboxId): AsyncIterable<SandboxRuntimeEvent>`

Responsibilities:

- render templates using the current agent and gateway config
- create provider instance if no live `providerInstanceId` exists
- execute the init script once per provider instance before relay launch
- start the relay process as a long-running process inside the sandbox
- stop the provider instance or remote process when requested
- reconcile provider state into domain status

This manager is runtime orchestration only. It must not route channel binding
reconciliation through `RelayRuntime`.

## Provider Port

Define a provider-neutral port under gateway runtime or a new package if the
boundary becomes shared:

```ts
export interface SandboxProvider {
  readonly provider: "aio-sandbox";

  create(input: SandboxCreateInput): Promise<SandboxProviderInstance>;
  start(instanceId: string): Promise<SandboxProviderInstance>;
  stop(instanceId: string): Promise<SandboxProviderInstance>;
  delete(instanceId: string): Promise<void>;
  get(instanceId: string): Promise<SandboxProviderInstance>;

  exec(input: SandboxExecInput): Promise<SandboxExecResult>;
  startProcess(input: SandboxProcessInput): Promise<SandboxProcessHandle>;
  stopProcess(input: SandboxStopProcessInput): Promise<void>;
  streamEvents(instanceId: string): AsyncIterable<SandboxProviderEvent>;
}
```

Provider-neutral DTOs:

```ts
export interface SandboxCreateInput {
  readonly sandboxId: string;
  readonly name: string;
  readonly image?: string;
  readonly resources?: SandboxSpec["resources"];
  readonly env: readonly ResolvedSandboxEnvVar[];
  readonly ttlSeconds?: number;
}

export interface SandboxExecInput {
  readonly instanceId: string;
  readonly command: readonly string[];
  readonly cwd?: string;
  readonly env?: readonly ResolvedSandboxEnvVar[];
  readonly timeoutMs?: number;
  readonly redact?: readonly string[];
}

export interface SandboxProcessInput extends SandboxExecInput {
  readonly restartPolicy: "never" | "on-failure" | "always";
}
```

`AioSandboxProvider` maps this port to the provider's JavaScript instance
management API. Keep all provider-specific auth, instance status names,
operation IDs, retry behavior, and polling quirks inside this adapter.

### `aio-sandbox` Adapter Mapping

The JavaScript SDK exposes an instance as a session. The adapter should map the
provider-neutral lifecycle to these SDK calls:

| AgentRelay port | `aio-sandbox` JavaScript SDK |
|---|---|
| provider client construction | `new SandboxClient({ psm, sandboxId, region, baseUrl, timeout, headers, token, enableZtiAuth })` |
| create/start instance | `client.createSession({ ttl, image, envs, metadata, resource_limit, command, prestop_command, expose_ports, sessionId })` |
| refresh state | `client.getSessionInfo(sandboxId, sessionId)` or `session.getInfo()` |
| list provider sessions | `client.listSessions({ page_number, page_size })` |
| extend TTL | `client.updateSession(sessionId, ttl, sandboxId)` or `session.update(ttl)` |
| stop/delete instance | `client.deleteSession(sessionId, sandboxId)` or `session.delete()` |
| execute init command | `session.aio.shell.execCommand({ command })` |

Provider configuration needed by the adapter:

- `psm` or provider `sandboxId`, exactly one required by the SDK
- optional `region`
- optional `baseUrl` for non-default control planes
- optional `timeout`, defaulting to the SDK's five-minute request timeout
- auth headers or token source for ZTI/JWT

`aio-sandbox` status values such as `pending`, `running`, `active`, `expired`,
and `deleted` must be normalized to `SandboxStatus`. The mapping belongs inside
`AioSandboxProvider`, not in HTTP routes or domain aggregates.

Git bootstrap can use the provider-supported `X-User-Jwt-Token` header so the
sandbox receives generated Git credentials. The domain model should represent
that as a secret reference or provider auth option; it should not expose raw JWT
values in sandbox specs.

## Lifecycle

### Create Sandbox Definition

```text
POST /api/sandboxes
  -> validate ws-tunnel agent
  -> validate template variables
  -> persist SandboxAggregate(status="stopped")
```

Creating a definition does not create a provider instance unless `autoStart` is
true.

### Start Sandbox

```text
POST /api/sandboxes/:id/start
  -> status starting
  -> provider.create/start
  -> provider.exec(initScript)
  -> provider.startProcess(relay serve ...)
  -> status running
```

The relay process is considered healthy only when one of these is true:

- gateway observes a live `WsTunnelConnectionRegistry` connection for `agentId`
- provider process reports a running state and the health timeout has not
  expired

Prefer gateway-observed WebSocket connection for final readiness.

### Stop Sandbox

```text
POST /api/sandboxes/:id/stop
  -> status stopping
  -> stop relay process if process handle exists
  -> provider.stop(instanceId)
  -> status stopped
```

Stop is idempotent. Stopping an already stopped sandbox returns the current
snapshot.

### Failure Handling

- Init script non-zero exit: mark `failed`, keep provider instance for logs
  unless `cleanupOnFailure` is added later.
- Relay process exits immediately: mark `failed` unless restart policy is
  `always` and provider accepts the restart.
- Provider instance lost: mark `failed` and clear live process handle.
- Gateway restart: load persisted sandboxes and refresh provider state lazily
  when listed or explicitly refreshed. A later scheduler can reconcile active
  sandboxes periodically.

## HTTP Contract

### List Sandboxes

`GET /api/sandboxes`

```json
[
  {
    "id": "sandbox-uuid",
    "agentId": "agent-uuid",
    "name": "codex-prod",
    "provider": "aio-sandbox",
    "status": "running",
    "spec": {},
    "createdAt": "2026-05-19T00:00:00.000Z",
    "updatedAt": "2026-05-19T00:00:00.000Z"
  }
]
```

### Create Sandbox

`POST /api/sandboxes`

```json
{
  "agentId": "agent-uuid",
  "name": "codex-prod",
  "provider": "aio-sandbox",
  "spec": {
    "workspace": { "path": "/workspace" },
    "env": [
      { "name": "RELAY_GATEWAY_URL", "value": "{{gateway.url}}" },
      { "name": "RELAY_TOKEN", "value": "{{relay.token}}" }
    ],
    "initScript": {
      "shell": "bash",
      "content": "set -euo pipefail\ncd {{workspace.path}}\npnpm install"
    },
    "relay": {
      "restartPolicy": "always"
    }
  }
}
```

### Start/Stop

```http
POST /api/sandboxes/:id/start
POST /api/sandboxes/:id/stop
POST /api/sandboxes/:id/refresh
DELETE /api/sandboxes/:id
```

### Events

`GET /api/sandboxes/:id/events`

Server-Sent Events:

```text
event: status
data: {"status":"starting","updatedAt":"..."}

event: log
data: {"stream":"stdout","text":"Installing dependencies..."}

event: relay-connected
data: {"agentId":"agent-uuid","connectedAt":"..."}

event: error-state
data: {"message":"init script failed with exit code 1"}
```

Events should replay the latest snapshot first, then stream new events. Log
events must pass through a redactor initialized with all resolved secret values.

## Persistence

Add Prisma-managed tables:

- `Sandbox`
  - `id`
  - `agentId`
  - `name`
  - `provider`
  - `specJson`
  - `status`
  - `providerInstanceId`
  - `lastError`
  - `createdAt`
  - `updatedAt`
- `SandboxEvent` or use the existing event-store pattern if this aggregate is
  event-sourced.
  - `id`
  - `sandboxId`
  - `eventType`
  - `payloadJson`
  - `createdAt`

Use Prisma migrations for schema changes. Do not introduce separate SQL scripts.

## Admin UI

Add a protected `Sandboxes` section in `apps/web`.

Navigation:

- Add a sidebar item between `Agents` and `Messages`.

List view:

- rows: name, agent, provider, status, workspace, updated time, actions
- actions: start, stop, refresh, edit, delete, open logs
- status badge colors should match existing dashboard status patterns

Create/edit view:

- select an ACP Remote agent only
- provider selector defaulting to `aio-sandbox`
- image/resources fields
- workspace path field
- env table with name/value/secret-ref modes
- init script textarea with validation feedback for unknown variables
- relay command advanced section, collapsed by default
- auto-start checkbox

Detail/logs view:

- current status and provider instance id
- live SSE log output with redacted secrets
- latest relay connection status from the gateway runtime status source

The UI should stay operational and dense like the existing admin pages; no
marketing-style landing page is needed.

## Security

- Relay tokens are secrets. The sandbox service may render them only into
  provider secret env values or process env, never into public API responses.
- Sandbox logs must redact token values and any env value marked secret.
- Init scripts are operator-provided code and should be treated as privileged.
  Add role checks when the auth model gains roles; phase 1 uses existing admin
  authentication.
- Provider credentials live in gateway environment/config, not in sandbox specs.
- Prefer short-lived provider instances or explicit TTLs for cloud cost control.

## Incremental Implementation Plan

1. Add domain types, repository port, and request schemas for sandbox
   definitions.
2. Add `SandboxProvider`, `SandboxRuntimeManager`, and a fake in-memory provider
   for tests.
3. Add `AioSandboxProvider` adapter behind the provider port.
4. Add HTTP routes and SSE events.
5. Add Prisma migration and state repository.
6. Add admin UI list/create/detail screens.
7. Wire relay readiness to `WsTunnelConnectionRegistry.isConnected(agentId)`.
8. Add focused tests:
   - template validation and redaction
   - start lifecycle orders create -> init -> relay
   - idempotent stop
   - one active sandbox per ws-tunnel agent
   - HTTP schema rejects non-ACP-Remote agents

## Open Questions

- Which gateway URL should the cloud sandbox use in each deployment environment:
  `runtimeAddress`, a new `PUBLIC_GATEWAY_URL`, or a sandbox-specific egress
  URL?
- Should the init script run on every start or only when a provider instance is
  first created?
- Should failed sandboxes be kept running for debugging by default, or should
  they be stopped to control cloud cost?
- Does `aio-sandbox` support managed long-running process restart policies, or
  should AgentRelay run a small supervisor command inside the sandbox?
- Should secrets come from existing gateway config only, or is a first-class
  secret store needed before UI-based env editing ships?
