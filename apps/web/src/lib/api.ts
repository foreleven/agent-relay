/**
 * Typed API client for the Agent Relay Gateway REST API.
 *
 * Browser requests must stay same-origin so the gateway session cookie is set
 * on the Web app origin where Next proxy can read it. Next.js rewrites `/api/*`
 * to the gateway (see next.config.ts).
 */

const BASE = "";

// ---------------------------------------------------------------------------
// Shared DTOs returned by the gateway API.
// ---------------------------------------------------------------------------

export interface ChannelBinding {
  id: string;
  name: string;
  channelType: string;
  accountId: string;
  channelConfig: Record<string, unknown>;
  agentId: string;
  sessionIsolationStrategy: SessionIsolationStrategy;
  enabled: boolean;
  createdAt: string;
}

export interface AgentConfig {
  id: string;
  name: string;
  protocol: AgentProtocol;
  config: AgentProtocolConfig;
  description?: string;
  createdAt: string;
}

export type AgentProtocol = "a2a" | "acp" | "ws-tunnel";

export interface A2AAgentConfig {
  url: string;
  contextIdStrategy?: A2AContextIdStrategy;
}

export type A2AContextIdStrategy = "client-provided" | "server-assigned";
export type SessionIsolationStrategy = "request" | "sessionKey" | "accountId";

export interface ACPStdioAgentConfig {
  transport: "stdio";
  command: string;
  args?: string[];
  cwd?: string;
  permission?:
    | "allow_once"
    | "allow_always"
    | "reject_once"
    | "reject_always";
  timeoutMs?: number;
}

export interface ClaudeCodeExecutorConfig {
  type: "claude-code";
  model?: string;
  systemPrompt?: string;
  maxTurns?: number;
  allowedTools?: string[];
}

export type WsTunnelExecutorConfig = ClaudeCodeExecutorConfig;

export interface WsTunnelAgentConfig {
  transport: "ws-tunnel";
  executor: WsTunnelExecutorConfig;
  timeoutMs?: number;
  /** Present only in the POST /api/agents creation response. Redacted in GET responses. */
  relayToken?: string;
}

export type AgentProtocolConfig =
  | A2AAgentConfig
  | ACPStdioAgentConfig
  | WsTunnelAgentConfig;

export type RuntimeChannelOwnership =
  | "local"
  | "cluster-lease"
  | "unassigned"
  | "disabled";

export interface RuntimeChannelStatus {
  bindingId: string;
  mode: "local" | "cluster";
  ownership: RuntimeChannelOwnership;
  status:
    | "idle"
    | "connecting"
    | "connected"
    | "disconnected"
    | "error"
    | "unknown";
  ownerNodeId?: string;
  ownerDisplayName?: string;
  error?: string;
  updatedAt?: string;
  leaseHeld: boolean;
}

export type ChannelMessageDirection = "input" | "output";

export interface ChannelMessage {
  id?: string;
  channelBindingId: string;
  direction: ChannelMessageDirection;
  channelType: string;
  accountId: string;
  sessionKey: string;
  content: string;
  metadata?: Record<string, unknown>;
  createdAt?: string;
}

export interface ChannelQrLoginStartResult {
  qrDataUrl?: string;
  message: string;
  accountId?: string;
  sessionKey?: string;
}

export interface ChannelQrLoginWaitResult {
  connected: boolean;
  message: string;
  accountId?: string;
  channelConfig?: Record<string, unknown>;
}

export interface AccountInfo {
  id: string;
  username: string;
  createdAt: string;
}

export interface LoginResult {
  account: AccountInfo;
  token: string;
}

function withCredentials(init?: RequestInit): RequestInit {
  return { ...init, credentials: "include" };
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export async function register(
  username: string,
  password: string,
): Promise<LoginResult> {
  const res = await fetch(`${BASE}/api/auth/register`, withCredentials({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  }));
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<LoginResult>;
}

export async function login(
  username: string,
  password: string,
): Promise<LoginResult> {
  const res = await fetch(`${BASE}/api/auth/login`, withCredentials({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  }));
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<LoginResult>;
}

export async function getMe(): Promise<AccountInfo | null> {
  const res = await fetch(`${BASE}/api/auth/me`, withCredentials());
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<AccountInfo>;
}

export async function logout(): Promise<void> {
  const res = await fetch(`${BASE}/api/auth/logout`, withCredentials({
    method: "POST",
  }));
  if (!res.ok) throw new Error(await res.text());
}

// ---------------------------------------------------------------------------
// Channel bindings
// ---------------------------------------------------------------------------

export async function listChannels(): Promise<ChannelBinding[]> {
  const res = await fetch(`${BASE}/api/channels`, withCredentials());
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<ChannelBinding[]>;
}

export async function createChannel(
  data: Omit<ChannelBinding, "id" | "createdAt" | "accountId"> & {
    accountId?: string;
  },
): Promise<ChannelBinding> {
  const res = await fetch(`${BASE}/api/channels`, withCredentials({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  }));
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<ChannelBinding>;
}

export async function updateChannel(
  id: string,
  data: Partial<Omit<ChannelBinding, "id" | "createdAt">>,
): Promise<ChannelBinding> {
  const res = await fetch(`${BASE}/api/channels/${id}`, withCredentials({
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  }));
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<ChannelBinding>;
}

export async function deleteChannel(id: string): Promise<void> {
  const res = await fetch(`${BASE}/api/channels/${id}`, withCredentials({
    method: "DELETE",
  }));
  if (!res.ok) throw new Error(await res.text());
}

export async function startChannelQrLogin(
  channelType: string,
  data: { accountId?: string; force?: boolean },
): Promise<ChannelQrLoginStartResult> {
  const res = await fetch(
    `${BASE}/api/channels/${encodeURIComponent(channelType)}/auth/qr/start`,
    withCredentials({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    }),
  );
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<ChannelQrLoginStartResult>;
}

export async function waitForChannelQrLogin(
  channelType: string,
  data: { accountId?: string; sessionKey?: string; timeoutMs?: number },
): Promise<ChannelQrLoginWaitResult> {
  const res = await fetch(
    `${BASE}/api/channels/${encodeURIComponent(channelType)}/auth/qr/wait`,
    withCredentials({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    }),
  );
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<ChannelQrLoginWaitResult>;
}

export async function listMessages(
  params: { limit?: number; channelBindingId?: string; agentId?: string } = {},
): Promise<ChannelMessage[]> {
  const { limit = 25, channelBindingId, agentId } = params;
  const query = new URLSearchParams({ limit: String(limit) });
  if (channelBindingId) query.set("channelBindingId", channelBindingId);
  if (agentId) query.set("agentId", agentId);
  const res = await fetch(`${BASE}/api/messages?${query}`, withCredentials());
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<ChannelMessage[]>;
}

// ---------------------------------------------------------------------------
// Agent configs
// ---------------------------------------------------------------------------

export async function listAgents(): Promise<AgentConfig[]> {
  const res = await fetch(`${BASE}/api/agents`, withCredentials());
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<AgentConfig[]>;
}

export async function createAgent(
  data: Omit<AgentConfig, "id" | "createdAt">,
): Promise<AgentConfig> {
  const res = await fetch(`${BASE}/api/agents`, withCredentials({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  }));
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<AgentConfig>;
}

export async function updateAgent(
  id: string,
  data: Partial<Omit<AgentConfig, "id" | "createdAt">>,
): Promise<AgentConfig> {
  const res = await fetch(`${BASE}/api/agents/${id}`, withCredentials({
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  }));
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<AgentConfig>;
}

export async function deleteAgent(id: string): Promise<void> {
  const res = await fetch(`${BASE}/api/agents/${id}`, withCredentials({
    method: "DELETE",
  }));
  if (!res.ok) throw new Error(await res.text());
}

export async function regenerateRelayToken(
  id: string,
): Promise<{ relayToken: string }> {
  const res = await fetch(
    `${BASE}/api/agents/${id}/regenerate-token`,
    withCredentials({ method: "POST" }),
  );
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<{ relayToken: string }>;
}

// ---------------------------------------------------------------------------
// Runtime status
// ---------------------------------------------------------------------------

export async function listRuntimeChannelStatuses(): Promise<
  RuntimeChannelStatus[]
> {
  const res = await fetch(
    `${BASE}/api/runtime/connections`,
    withCredentials(),
  );
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<RuntimeChannelStatus[]>;
}

// ---------------------------------------------------------------------------
// Scheduled jobs
// ---------------------------------------------------------------------------

export interface ScheduledJob {
  id: string;
  name: string;
  channelBindingId: string;
  sessionKey: string;
  prompt: string;
  cronExpression: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export async function listScheduledJobs(): Promise<ScheduledJob[]> {
  const res = await fetch(`${BASE}/api/scheduled-jobs`, withCredentials());
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<ScheduledJob[]>;
}

export async function createScheduledJob(
  data: Omit<ScheduledJob, "id" | "createdAt" | "updatedAt" | "enabled"> & {
    enabled?: boolean;
  },
): Promise<ScheduledJob> {
  const res = await fetch(`${BASE}/api/scheduled-jobs`, withCredentials({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  }));
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<ScheduledJob>;
}

export async function updateScheduledJob(
  id: string,
  data: Partial<Omit<ScheduledJob, "id" | "createdAt" | "updatedAt">>,
): Promise<ScheduledJob> {
  const res = await fetch(`${BASE}/api/scheduled-jobs/${id}`, withCredentials({
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  }));
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<ScheduledJob>;
}

export async function deleteScheduledJob(id: string): Promise<void> {
  const res = await fetch(`${BASE}/api/scheduled-jobs/${id}`, withCredentials({
    method: "DELETE",
  }));
  if (!res.ok) throw new Error(await res.text());
}
