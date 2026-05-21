# AgentRelay

AgentRelay is a TypeScript gateway that connects messaging-channel plugins to
remote agent servers.

It hosts OpenClaw channel plugins, keeps channel account connections running,
routes inbound messages to a configured agent, and sends the agent response back
through the original channel. The current runtime supports A2A JSON-RPC agents
and ACP agents over REST or stdio.

```text
Messaging platform
  Feishu / Lark / WeChat / QQBot / Discord / Slack / Telegram / WhatsApp
          |
          | OpenClaw channel plugin
          v
      AgentRelay gateway
          |
          | A2A JSON-RPC or ACP REST/stdio
          v
       Agent server
```

## Why AgentRelay Exists

Agent projects usually need the same channel plumbing:

- connect to chat platforms and keep long-lived accounts online
- normalize inbound messages from different providers
- route each account or channel binding to the right agent backend
- deliver the agent response through the original provider
- expose operational APIs and a UI for managing those bindings

AgentRelay keeps that work in one gateway. Channel-specific behavior stays in
OpenClaw plugins; agent-specific behavior stays behind transport adapters.

## What Is Included

- Hono gateway API for channel bindings, agent configs, and runtime status
- SQLite persistence through Prisma and `better-sqlite3`
- OpenClaw plugin host/runtime compatibility layer
- Runtime lifecycle orchestration for starting, restarting, and stopping channel
  connections
- Local single-node runtime mode and Redis-backed cluster mode
- A2A and ACP transport adapters
- Next.js admin UI
- Minimal A2A echo agent for local testing

## Current Channel Plugins

The gateway registers these OpenClaw channel plugins in
`apps/gateway/src/register-plugins.ts`:

| Channel | Package/source |
|---|---|
| Feishu / Lark | `@openclaw/feishu` |
| Discord | `@openclaw/discord` |
| Slack | bundled OpenClaw extension |
| Telegram | bundled OpenClaw extension |
| WhatsApp | `@openclaw/whatsapp` |
| Weixin / WeChat | `@openclaw/weixin` |
| QQBot | `@openclaw/qqbot` |

Aliases are normalized at the gateway boundary. For example, `lark` maps to
`feishu`, and `wechat` / `weixin` map to `openclaw-weixin`.

## Message Flow

1. A channel provider delivers an inbound message through an OpenClaw plugin.
2. AgentRelay receives the plugin runtime reply event.
3. The runtime resolves the enabled channel binding for that channel/account.
4. The binding points to an agent config with a protocol-specific config.
5. The agent transport sends the message to the remote agent.
6. The first text response is sent back through the same channel plugin.

```text
Channel account
    -> OpenClawPluginHost
    -> OpenClawPluginRuntime
    -> ChannelBinding(agentId)
    -> AgentClient(protocol: a2a | acp)
    -> remote agent
    -> channel dispatcher reply
```

## Monorepo Layout

```text
apps/
  gateway/      Hono HTTP server, OpenClaw host, runtime orchestration, store
  echo-agent/   Minimal A2A-compatible echo agent for local testing
  relay/        CLI that connects an ACP executor to the gateway via WebSocket tunnel
  web/          Next.js admin UI for channels, agents, and runtime status

packages/
  agent-transport/   A2A and ACP transport adapters
  domain/            Aggregates, domain events, snapshots, repository ports
  event-store/       Event-store port and stored event types
  openclaw-compat/   OpenClaw plugin host/runtime compatibility layer
```

The repository is being renamed to AgentRelay, but the current workspace package
scope is still `@agent-relay/*`.

## Quick Start

Prerequisites:

- Node.js 20 or newer
- pnpm 10.32.0

```bash
pnpm install
pnpm dev
```

`pnpm dev` starts the local development stack with gateway readiness ordering.
By default:

- gateway API: `http://localhost:7890`
- admin UI: `http://localhost:3000`
- echo agent: `http://localhost:3001`

You can also start each process separately:

```bash
# Terminal 1: example A2A agent
pnpm echo-agent

# Terminal 2: gateway API
pnpm gateway

# Terminal 3: admin UI
pnpm web
```

Seed the database with a default echo agent and optional Feishu binding:

```bash
pnpm seed
```

## Configuration

The gateway reads `.env` from the repository root when launched through the
provided Makefile-backed commands.

| Variable | Default | Description |
|---|---:|---|
| `PORT` | `7890` | Gateway HTTP port |
| `DB_PATH` | `./db/agent-relay.db` | SQLite database path |
| `CORS_ORIGIN` | `http://localhost:3000` | Allowed browser origin for gateway API calls |
| `RUNTIME_ADDRESS` | `http://localhost:$PORT` | Address advertised by this runtime node |
| `NODE_ID` | `RUNTIME_ADDRESS` | Runtime node identity |
| `NODE_DISPLAY_NAME` | `Gateway Node` | Human-readable node name in runtime status |
| `LOG_LEVEL` | `info` | Gateway logger level |
| `LOG_PRETTY` | auto | Enables `pino-pretty` output when set to `true`; set to `false` to force JSON logs |
| `CLUSTER_MODE` | `false` | Enables Redis-backed runtime coordination when set to `true` |
| `REDIS_URL` | - | Redis connection URL for cluster mode |
| `BUNQUEUE_ENABLED` | `false` | Enables the BunQueue scheduled job worker |
| `BUNQUEUE_HOST` | `localhost` | BunQueue TCP server host |
| `BUNQUEUE_PORT` | `6789` | BunQueue TCP server port |
| `BUNQUEUE_TOKEN` | - | Optional BunQueue auth token |
| `BUNQUEUE_QUEUE` | `scheduled-jobs` | Queue consumed by scheduled job workers |
| `BUNQUEUE_WORKER_CONCURRENCY` | `2` | Scheduled job worker concurrency per gateway process |
| `BUNQUEUE_PREFIX` | - | Optional BunQueue namespace prefix |
| `SANDBOX_AIO_PSM` | - | aio-sandbox PSM identifier; mutually exclusive with `SANDBOX_AIO_SANDBOX_ID` |
| `SANDBOX_AIO_SANDBOX_ID` | - | aio-sandbox Sandbox ID; mutually exclusive with `SANDBOX_AIO_PSM` |
| `SANDBOX_AIO_REGION` | auto | Optional aio-sandbox region |
| `SANDBOX_AIO_BASE_URL` | - | Optional aio-sandbox control-plane URL |
| `SANDBOX_AIO_TOKEN` | - | Optional aio-sandbox JWT/ZTI token |
| `SANDBOX_AIO_USER_JWT` | - | Optional user JWT used by aio-sandbox to generate Git credentials |
| `SANDBOX_AIO_TIMEOUT_MS` | `300000` | aio-sandbox SDK request timeout |
| `ECHO_AGENT_PORT` | `3001` | Echo agent HTTP port |
| `ECHO_AGENT_URL` | `http://localhost:$ECHO_AGENT_PORT` | Echo agent base URL and seed target URL |
| `FEISHU_APP_ID` | - | Feishu/Lark app ID used by `pnpm seed` |
| `FEISHU_APP_SECRET` | - | Feishu/Lark app secret used by `pnpm seed` |
| `FEISHU_ACCOUNT_ID` | `default` | Account ID for the seeded Feishu binding |
| `FEISHU_VERIFICATION_TOKEN` | - | Optional Feishu event verification token |
| `FEISHU_ENCRYPT_KEY` | - | Optional Feishu message encrypt key |

Scheduled jobs are stored and triggered by BunQueue, not by the gateway database.
Start a BunQueue server and create cron jobs in the `scheduled-jobs` queue:

```bash
bunqueue start --tcp-port 6789

bunqueue cron add daily-summary \
  -q scheduled-jobs \
  -s "0 9 * * *" \
  -z UTC \
  -d '{"bindingId":"binding-id","sessionKey":"agent:any:feishu:default:direct:ou_xxx","prompt":"Send the daily summary."}'
```

For the admin UI:

| Variable | Default | Description |
|---|---:|---|
| `GATEWAY_URL` | `http://localhost:7890` | Gateway URL used by Next.js dev rewrites |
| `NEXT_PUBLIC_GATEWAY_URL` | empty | Browser-side gateway URL for production deployments |

## HTTP API

The admin UI uses the gateway API under `/api/*`.

### Agents

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/agents` | List agent configs |
| `GET` | `/api/agents/:id` | Get one agent config |
| `POST` | `/api/agents` | Create an agent config |
| `PATCH` | `/api/agents/:id` | Update an agent config |
| `DELETE` | `/api/agents/:id` | Delete an agent config |

Example:

```json
{
  "name": "echo-agent",
  "protocol": "a2a",
  "config": {
    "url": "http://localhost:3001"
  },
  "description": "Local test agent"
}
```

Agent names are also used as ACP workspace folder names, so they must be a
single folder-safe segment containing only letters, numbers, `.`, `_`, and `-`.

Supported protocols are registered through transport adapters. The current
gateway binds `a2a`, `acp`, and `ws-tunnel`.

`ws-tunnel` is exposed in the admin UI as **ACP Remote**. It is for ACP agents
that cannot accept inbound TCP connections and still connect to the gateway
through the WebSocket relay. See [docs/ws-tunnel.md](docs/ws-tunnel.md).

### Sandboxes

Sandboxes provision a managed runtime for an ACP Remote agent. The first
provider adapter targets aio-sandbox and maps AgentRelay start/stop operations
to aio-sandbox session lifecycle calls. A sandbox can run an initialization
script with template variables, then start the relay CLI inside the sandbox.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/sandboxes` | List sandbox definitions |
| `GET` | `/api/sandboxes/:id` | Get one sandbox |
| `POST` | `/api/sandboxes` | Create a sandbox definition |
| `PATCH` | `/api/sandboxes/:id` | Update sandbox name or spec |
| `POST` | `/api/sandboxes/:id/start` | Create/start provider session, run init script, and start relay |
| `POST` | `/api/sandboxes/:id/stop` | Stop the provider session |
| `POST` | `/api/sandboxes/:id/refresh` | Refresh provider state into gateway status |
| `DELETE` | `/api/sandboxes/:id` | Stop if needed and delete the definition |
| `GET` | `/api/sandboxes/:id/events` | Stream sandbox lifecycle events as SSE |

### Channels

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/channels` | List channel bindings |
| `GET` | `/api/channels/:id` | Get one channel binding |
| `POST` | `/api/channels` | Create a channel binding |
| `PATCH` | `/api/channels/:id` | Update a channel binding |
| `DELETE` | `/api/channels/:id` | Delete a channel binding |
| `POST` | `/api/channels/:channelType/auth/qr/start` | Start QR login for channels that support it |
| `POST` | `/api/channels/:channelType/auth/qr/wait` | Wait for a QR login result |

Example:

```json
{
  "name": "Feishu Bot",
  "channelType": "feishu",
  "accountId": "default",
  "agentId": "agent-config-id",
  "enabled": true,
  "channelConfig": {
    "appId": "cli_xxxx",
    "appSecret": "...",
    "verificationToken": "...",
    "encryptKey": "...",
    "allowFrom": ["*"]
  }
}
```

`channelConfig` is channel-specific and is passed to the selected OpenClaw
plugin when the account starts.

### Runtime Status

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/runtime/status` | Full runtime status read model |
| `GET` | `/api/runtime/nodes` | Runtime node list |
| `GET` | `/api/runtime/connections` | Channel connection status list |

## Agent Backends

### A2A

For `protocol: "a2a"`, AgentRelay uses the A2A SDK client to discover the agent
from `config.url` and sends a `message/send` JSON-RPC request. The echo
agent in `apps/echo-agent` exposes:

| Method | Path | Description |
|---|---|---|
| `GET` | `/.well-known/agent-card.json` | A2A agent card |
| `POST` | `/a2a/jsonrpc` | A2A JSON-RPC endpoint |
| `POST` | `/a2a/rest` | A2A HTTP+JSON endpoint |

### ACP Remote

For `protocol: "ws-tunnel"`, AgentRelay routes A2A JSON-RPC frames through a
persistent WebSocket opened by the relay CLI running on the agent host.  This
lets agents behind NAT or firewalls connect outward to the gateway without
requiring inbound TCP connections. The relay CLI starts the configured ACP
stdio executor; `claude-code` and `codex` executor types are supported.

Example Codex ACP Remote executor:

```json
{
  "name": "remote-codex",
  "protocol": "ws-tunnel",
  "config": {
    "transport": "ws-tunnel",
    "executor": {
      "type": "codex",
      "command": "npx",
      "args": ["@zed-industries/codex-acp"]
    }
  }
}
```

See [docs/ws-tunnel.md](docs/ws-tunnel.md) for the full protocol description,
gateway API reference, and relay CLI usage.

### ACP

For `protocol: "acp"` with `{ "transport": "stdio" }`, AgentRelay starts the
configured command as a local stdio process and talks to it with the Agent
Client Protocol. This is intended for adapters such as Zed Codex ACP:

```json
{
  "name": "Codex",
  "protocol": "acp",
  "config": {
    "transport": "stdio",
    "command": "npx",
    "args": ["@zed-industries/codex-acp"]
  },
  "description": "Local Codex ACP adapter over ACP stdio"
}
```

Install `codex-acp` from a release or use the npm command above. The process
inherits the gateway environment, so provide `OPENAI_API_KEY`,
`CODEX_API_KEY`, or an authenticated Codex setup before routing messages to it.
`config.cwd` controls the ACP session working directory and defaults to
`ACP_STDIO_CWD` or the gateway process directory. Tool permission requests are
rejected by default; set `config.permission` or `ACP_STDIO_PERMISSION` to
`allow_once` only when the gateway process is allowed to grant tool execution
for inbound channel messages.

#### Per-account process isolation

When `ACP_BASE_PATH` is set, the gateway creates a separate child process and
working directory for each account that sends a message to an ACP agent. The
working directory is derived as:

```
${ACP_BASE_PATH}/<agentId>/<accountId>
```

where `<agentId>` is the agent's unique identifier. When `ACP_BASE_PATH` is
active, `config.cwd` is ignored for account-routed requests; it is still used
when a request carries no `accountId`. This feature is intended for ACP agents
that maintain per-user state on disk (e.g. Codex workspace files).

## Development Commands

```bash
# Type-check the non-web TypeScript project
pnpm typecheck

# Run gateway tests
pnpm test

# Type-check the admin UI
cd apps/web && npx tsc --noEmit

# Lint the admin UI
cd apps/web && pnpm lint

# Build the admin UI
cd apps/web && pnpm build
```

There is no repo-wide lint script. The root `pnpm test` target currently runs
gateway tests under `apps/gateway/src`.

## Architecture Notes

- `apps/gateway/src/bootstrap/container.ts` is the composition root and wires
  infrastructure, application services, runtime services, HTTP routes, and
  process lifecycle services through Inversify.
- `packages/domain` owns channel binding and agent config model boundaries.
- Prisma-backed repositories in `apps/gateway/src/infra` persist those models.
- `RuntimeAssignmentCoordinator` decides which enabled bindings this runtime
  node owns.
- `ConnectionManager` performs the imperative plugin account lifecycle work.
- `OpenClawPluginHost` bridges registered OpenClaw plugins to gateway runtime
  connections.
- `OpenClawPluginRuntime` implements the minimal runtime surface needed for
  channel-to-agent forwarding.
- `RuntimeOpenClawConfigProjection` synthesizes OpenClaw-compatible config from
  runtime-owned bindings.
- `RelayRuntime` assembles runtime behavior but assignment reconciliation must
  stay behind the lower-level ownership and assignment services.

To add a channel, install or implement an OpenClaw-compatible channel plugin and
register it in `apps/gateway/src/register-plugins.ts`. No gateway-specific
wrapper package is required when the plugin conforms to the OpenClaw channel
plugin API.
