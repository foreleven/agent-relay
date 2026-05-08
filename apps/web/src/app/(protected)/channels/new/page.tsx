"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  CheckCircle2,
  Loader2,
  QrCode,
  RadioTower,
} from "lucide-react";

import type { AgentConfig } from "@/lib/api";
import {
  createChannel,
  listAgents,
  startChannelQrLogin,
  waitForChannelQrLogin,
} from "@/lib/api";
import {
  CHANNEL_CONFIG_FIELDS,
  CHANNEL_CONFIG_TEMPLATES,
  CHANNEL_OPTIONS,
  ChannelFormMapper,
  SESSION_ISOLATION_OPTIONS,
  type FormState,
  channelCreateHref,
  channelGuide,
  channelLabel,
  normalizeChannelType,
  stringifyConfig,
  supportsQrLogin,
} from "@/lib/channel-binding-form";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Field as ShadcnField,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

type QrState = {
  imageUrl?: string;
  message?: string;
  sessionKey?: string;
  accountId?: string;
  connectedAccountId?: string;
  pollingStopped?: boolean;
};

const formMapper = new ChannelFormMapper();

export default function NewChannelBindingDefaultPage() {
  return <NewChannelBindingPage initialChannelType="feishu" key="feishu" />;
}

export function NewChannelBindingPage({
  initialChannelType,
}: {
  initialChannelType: string;
}) {
  const router = useRouter();
  const routeChannelType = normalizeChannelType(initialChannelType);
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const [form, setForm] = useState<FormState>(() =>
    createFormState(routeChannelType),
  );
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [qrLoading, setQrLoading] = useState(false);
  const [qrState, setQrState] = useState<QrState>({});
  const [error, setError] = useState<string | null>(null);

  const selectedChannel = useMemo(
    () => CHANNEL_OPTIONS.find((channel) => channel.value === form.channelType),
    [form.channelType],
  );
  const guide = useMemo(
    () => channelGuide(form.channelType),
    [form.channelType],
  );
  const qrPolling =
    supportsQrLogin(form.channelType) &&
    Boolean(qrState.sessionKey) &&
    !qrState.connectedAccountId &&
    !qrState.pollingStopped &&
    !qrLoading;

  useEffect(() => {
    let cancelled = false;
    async function loadAgents() {
      try {
        const nextAgents = await listAgents();
        if (cancelled) return;
        setAgents(nextAgents);
        setForm((current) => ({
          ...current,
          agentId: current.agentId || nextAgents[0]?.id || "",
        }));
      } catch (loadError) {
        if (!cancelled) setError(String(loadError));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void loadAgents();
    return () => {
      cancelled = true;
    };
  }, []);

  const updateConfigValue = useCallback(
    (key: string, value: string | boolean) => {
      setForm((current) => {
        const currentConfig = parseConfig(current.channelConfigJson);
        const nextValue =
          key === "allowFrom" && typeof value === "string"
            ? value
                .split(",")
                .map((item) => item.trim())
                .filter(Boolean)
            : value;
        return {
          ...current,
          channelConfigJson: stringifyConfig({
            ...currentConfig,
            [key]: nextValue,
          }),
        };
      });
    },
    [],
  );

  async function startQr() {
    setQrLoading(true);
    setError(null);
    setQrState({});
    try {
      const result = await startChannelQrLogin(form.channelType, {
        accountId: form.accountId || undefined,
        force: true,
      });
      if (result.accountId) {
        setForm((current) => ({
          ...current,
          accountId: result.accountId ?? "",
        }));
      }
      setQrState({
        imageUrl: result.qrDataUrl,
        message: result.message,
        sessionKey: result.sessionKey,
        accountId: result.accountId,
      });
    } catch (qrError) {
      setError(String(qrError));
    } finally {
      setQrLoading(false);
    }
  }

  const checkQr = useCallback(
    async (options: { silent?: boolean } = {}): Promise<boolean> => {
      if (!qrState.sessionKey) {
        return false;
      }
      if (!options.silent) {
        setQrLoading(true);
        setError(null);
      }
      try {
        const result = await waitForChannelQrLogin(form.channelType, {
          accountId: form.accountId || qrState.accountId || undefined,
          sessionKey: qrState.sessionKey,
          timeoutMs: options.silent ? 5_000 : 30_000,
        });
        const pollingStopped =
          result.connected || isTerminalQrMessage(result.message);
        setQrState((current) => ({
          ...current,
          message: result.message,
          connectedAccountId: result.accountId,
          pollingStopped,
        }));
        if (result.connected && result.accountId) {
          const accountId = result.accountId;
          setForm((current) => ({
            ...current,
            accountId,
            channelConfigJson: result.channelConfig
              ? stringifyConfig({
                  ...parseConfig(current.channelConfigJson),
                  ...result.channelConfig,
                })
              : current.channelConfigJson,
          }));
        }
        return pollingStopped;
      } catch (qrError) {
        if (!options.silent) {
          setError(String(qrError));
        }
        return false;
      } finally {
        if (!options.silent) {
          setQrLoading(false);
        }
      }
    },
    [form.accountId, form.channelType, qrState.accountId, qrState.sessionKey],
  );

  useEffect(() => {
    if (
      !supportsQrLogin(form.channelType) ||
      !qrState.sessionKey ||
      qrState.connectedAccountId
    ) {
      return;
    }

    let cancelled = false;
    let timer: number | undefined;

    async function poll() {
      const connected = await checkQr({ silent: true });
      if (cancelled || connected) {
        return;
      }
      timer = window.setTimeout(poll, 1500);
    }

    timer = window.setTimeout(poll, 1000);
    return () => {
      cancelled = true;
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
    };
  }, [
    checkQr,
    form.channelType,
    qrState.connectedAccountId,
    qrState.sessionKey,
  ]);

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      await createChannel(formMapper.toPayload(form));
      router.push("/channels");
    } catch (saveError) {
      setError(String(saveError));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex w-full flex-col gap-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <Button asChild className="mb-3" size="sm" variant="ghost">
            <Link href="/channels">
              <ArrowLeft />
              Channels
            </Link>
          </Button>
          <h1 className="text-2xl font-semibold tracking-normal">
            New Channel Binding
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Choose a provider and bind one account to an A2A agent.
          </p>
        </div>
        <Button
          disabled={saving || !form.name || !form.agentId}
          onClick={handleSave}
        >
          {saving ? "Saving..." : "Create Binding"}
        </Button>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="grid min-h-[620px] gap-5 lg:grid-cols-[280px_1fr]">
        <aside className="rounded-lg border border-border bg-card p-2">
          <div className="px-3 py-2">
            <p className="text-xs font-medium uppercase text-muted-foreground">
              Channel
            </p>
          </div>
          <div className="flex flex-col gap-1">
            {CHANNEL_OPTIONS.map((channel) => (
              <Link
                className={`flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors ${
                  form.channelType === channel.value
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                }`}
                href={channelCreateHref(channel.value)}
                key={channel.value}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <RadioTower className="size-4 shrink-0" />
                  <span className="truncate">{channel.label}</span>
                </span>
                {channel.supportsQr && <Badge variant="secondary">QR</Badge>}
              </Link>
            ))}
          </div>
        </aside>

        <Card className="min-w-0">
          <CardHeader className="border-b border-border">
            <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
              <div>
                <CardTitle>
                  {selectedChannel?.label ?? form.channelType}
                </CardTitle>
                <p className="mt-1 text-sm text-muted-foreground">
                  {supportsQrLogin(form.channelType)
                    ? "QR login can populate the channel settings before saving."
                    : "Enter the provider account configuration."}
                </p>
              </div>
              {supportsQrLogin(form.channelType) && (
                <Badge
                  variant={qrState.connectedAccountId ? "success" : "outline"}
                >
                  {qrState.connectedAccountId ? "connected" : "QR login"}
                </Badge>
              )}
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-6 p-5">
            {supportsQrLogin(form.channelType) && (
              <QrLoginPanel
                channelLabel={channelLabel(form.channelType)}
                loading={qrLoading}
                onCheck={checkQr}
                onStart={startQr}
                polling={qrPolling}
                state={qrState}
              />
            )}

            <ChannelGuidePanel guide={guide} />

            <FieldGroup className="grid gap-4 sm:grid-cols-2">
              <FormField label="Name">
                <Input
                  onChange={(event) =>
                    setForm({ ...form, name: event.target.value })
                  }
                  placeholder={`${channelLabel(form.channelType)} Bot`}
                  value={form.name}
                />
              </FormField>
              <FormField label="Enabled">
                <div className="flex h-8 items-center">
                  <Checkbox
                    className="w-fit"
                    checked={form.enabled}
                    onCheckedChange={(checked) =>
                      setForm({ ...form, enabled: checked === true })
                    }
                  />
                </div>
              </FormField>
              <FormField label="Agent">
                <Select
                  disabled={loading}
                  onValueChange={(agentId) => setForm({ ...form, agentId })}
                  value={form.agentId}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select an agent" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {agents.map((agent) => (
                        <SelectItem key={agent.id} value={agent.id}>
                          {agent.name}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </FormField>
              <FormField label="Session Isolation">
                <Select
                  onValueChange={(sessionIsolationStrategy) =>
                    setForm({
                      ...form,
                      sessionIsolationStrategy: parseSessionIsolationStrategy(
                        sessionIsolationStrategy,
                      ),
                    })
                  }
                  value={form.sessionIsolationStrategy}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {SESSION_ISOLATION_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </FormField>
            </FieldGroup>

            <ChannelConfigFields
              channelType={form.channelType}
              config={parseConfig(form.channelConfigJson)}
              onChange={updateConfigValue}
            />

            <FormField label="Advanced Config JSON">
              <Textarea
                className="min-h-36 font-mono text-xs"
                onChange={(event) =>
                  setForm({ ...form, channelConfigJson: event.target.value })
                }
                spellCheck={false}
                value={form.channelConfigJson}
              />
            </FormField>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function parseSessionIsolationStrategy(
  value: string,
): FormState["sessionIsolationStrategy"] {
  return value === "request" || value === "accountId" ? value : "sessionKey";
}

function QrLoginPanel({
  channelLabel,
  loading,
  onCheck,
  onStart,
  polling,
  state,
}: {
  channelLabel: string;
  loading: boolean;
  onCheck(): void;
  onStart(): void;
  polling: boolean;
  state: QrState;
}) {
  return (
    <div className="grid gap-4 rounded-md border border-border bg-muted/35 p-4 md:grid-cols-[220px_1fr]">
      <div className="flex aspect-square items-center justify-center rounded-md border border-border bg-background">
        {state.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            alt="WeChat login QR code"
            className="max-h-[190px] max-w-[190px]"
            src={state.imageUrl}
          />
        ) : (
          <QrCode className="size-12 text-muted-foreground" />
        )}
      </div>
      <div className="flex min-w-0 flex-col justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-sm font-medium">
            {state.connectedAccountId ? (
              <CheckCircle2 className="size-4 text-emerald-600" />
            ) : (
              <QrCode className="size-4" />
            )}
            {channelLabel} QR Login
          </div>
          <p className="mt-2 break-words text-sm text-muted-foreground">
            {polling
              ? "Waiting for scan confirmation..."
              : (state.message ??
                "Generate a QR code from the channel gateway.")}
          </p>
          {state.connectedAccountId && (
            <p className="mt-2 break-all text-xs text-muted-foreground">
              {state.connectedAccountId}
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button disabled={loading} onClick={onStart} variant="outline">
            {loading ? <Loader2 className="animate-spin" /> : <QrCode />}
            Generate QR
          </Button>
          <Button
            disabled={loading || polling || !state.sessionKey}
            onClick={onCheck}
            variant="secondary"
          >
            {loading || polling ? (
              <Loader2 className="animate-spin" />
            ) : (
              <CheckCircle2 />
            )}
            {polling ? "Checking..." : "Check Login"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function ChannelGuidePanel({
  guide,
}: {
  guide: ReturnType<typeof channelGuide>;
}) {
  return (
    <div className="rounded-md border border-border bg-background p-4">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
        <div className="min-w-0">
          <p className="text-sm font-medium">Configuration Guide</p>
          <p className="mt-1 text-sm text-muted-foreground">{guide.summary}</p>
        </div>
        <Button asChild size="sm" variant="outline">
          <a href={guide.docsUrl} rel="noreferrer" target="_blank">
            Docs
          </a>
        </Button>
      </div>
      <p className="mt-3 text-sm text-muted-foreground">{guide.setup}</p>
      <ul className="mt-3 grid gap-2 text-sm text-muted-foreground sm:grid-cols-2">
        {guide.fields.map((field) => (
          <li className="rounded-md bg-muted/60 px-3 py-2" key={field}>
            {field}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ChannelConfigFields({
  channelType,
  config,
  onChange,
}: {
  channelType: string;
  config: Record<string, unknown>;
  onChange(key: string, value: string | boolean): void;
}) {
  const fields = CHANNEL_CONFIG_FIELDS[channelType] ?? [];
  if (fields.length === 0) {
    return null;
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {fields.map((field) => (
        <FormField key={field.key} label={field.label}>
          {field.type === "boolean" ? (
            <div className="flex h-8 items-center gap-2">
              <Checkbox
                checked={config[field.key] === true}
                onCheckedChange={(checked) =>
                  onChange(field.key, checked === true)
                }
              />
            </div>
          ) : field.type === "select" && field.options ? (
            <Select
              onValueChange={(value) => onChange(field.key, value)}
              value={fieldValue(config[field.key])}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {field.options.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          ) : (
            <Input
              onChange={(event) => onChange(field.key, event.target.value)}
              type={
                field.secret || field.type === "secret" ? "password" : "text"
              }
              value={fieldValue(config[field.key])}
            />
          )}
          {field.help && <FieldDescription>{field.help}</FieldDescription>}
        </FormField>
      ))}
    </div>
  );
}

function FormField({
  className,
  label,
  children,
}: {
  className?: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <ShadcnField className={className}>
      <FieldLabel>{label}</FieldLabel>
      {children}
    </ShadcnField>
  );
}

function parseConfig(rawConfig: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(rawConfig || "{}") as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function fieldValue(value: unknown): string {
  if (Array.isArray(value)) return value.join(", ");
  return typeof value === "string" ? value : "";
}

function isTerminalQrMessage(message: string | undefined): boolean {
  if (!message) return false;
  return [
    "expired",
    "failed",
    "timeout",
    "二维码已过期",
    "登录超时",
    "登录失败",
    "当前没有进行中",
    "连接流程已停止",
    "无需重复连接",
  ].some((marker) => message.includes(marker));
}

function createFormState(channelType: string, agentId = ""): FormState {
  const normalizedChannelType = normalizeChannelType(channelType);
  return {
    name: "",
    channelType: normalizedChannelType,
    accountId: "",
    agentId,
    sessionIsolationStrategy: "sessionKey",
    enabled: true,
    channelConfigJson: stringifyConfig(
      CHANNEL_CONFIG_TEMPLATES[normalizedChannelType] ?? {},
    ),
  };
}
