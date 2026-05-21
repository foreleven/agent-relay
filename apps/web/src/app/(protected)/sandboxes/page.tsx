"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Container,
  Play,
  Plus,
  RefreshCw,
  Square,
  Trash2,
} from "lucide-react";

import type { AgentConfig, Sandbox, SandboxSpec } from "@/lib/api";
import {
  createSandbox,
  deleteSandbox,
  listAgents,
  listSandboxes,
  refreshSandbox,
  startSandbox,
  stopSandbox,
} from "@/lib/api";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Field as ShadcnField,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";

interface SandboxFormState {
  name: string;
  agentId: string;
  image: string;
  workspacePath: string;
  ttlSeconds: string;
  initScript: string;
}

const EMPTY_FORM: SandboxFormState = {
  name: "",
  agentId: "",
  image: "",
  workspacePath: "/workspace",
  ttlSeconds: "3600",
  initScript: "",
};

export default function SandboxesPage() {
  const [sandboxes, setSandboxes] = useState<Sandbox[]>([]);
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState<SandboxFormState>(EMPTY_FORM);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const [sandboxData, agentData] = await Promise.all([
        listSandboxes(),
        listAgents(),
      ]);
      setSandboxes(sandboxData);
      setAgents(agentData);
      if (!form.agentId) {
        const firstRemote = agentData.find((agent) => agent.protocol === "ws-tunnel");
        if (firstRemote) {
          setForm((current) => ({ ...current, agentId: firstRemote.id }));
        }
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [form.agentId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  const remoteAgents = useMemo(
    () => agents.filter((agent) => agent.protocol === "ws-tunnel"),
    [agents],
  );

  const runningCount = sandboxes.filter((sandbox) => sandbox.status === "running").length;
  const canSubmit =
    form.name.trim() &&
    form.agentId &&
    (!form.ttlSeconds.trim() || positiveInteger(form.ttlSeconds));

  async function handleCreate() {
    setSaving(true);
    try {
      await createSandbox({
        name: form.name.trim(),
        agentId: form.agentId,
        provider: "aio-sandbox",
        spec: toSpec(form),
      });
      setShowCreate(false);
      setForm({ ...EMPTY_FORM, agentId: form.agentId });
      await refresh();
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleStart(id: string) {
    try {
      await startSandbox(id);
      await refresh();
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleStop(id: string) {
    try {
      await stopSandbox(id);
      await refresh();
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleRefresh(id: string) {
    try {
      await refreshSandbox(id);
      await refresh();
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("Delete this sandbox?")) return;
    try {
      await deleteSandbox(id);
      await refresh();
    } catch (err) {
      setError(String(err));
    }
  }

  return (
    <div className="flex w-full flex-col gap-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <h1 className="text-2xl font-semibold tracking-normal">
            Sandboxes
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Manage cloud runtimes that host ACP Remote relay processes.
          </p>
        </div>
        <Button
          disabled={remoteAgents.length === 0}
          onClick={() => setShowCreate(true)}
        >
          <Plus />
          New Sandbox
        </Button>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <CardTitle>Sandbox Instances</CardTitle>
              <CardDescription>
                A sandbox prepares a workspace and starts relay CLI for one ACP Remote agent.
              </CardDescription>
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge variant="secondary">{sandboxes.length} total</Badge>
              <Badge variant="success">{runningCount} running</Badge>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex flex-col gap-3">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
            </div>
          ) : sandboxes.length === 0 ? (
            <Empty className="border">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Container className="size-4" />
                </EmptyMedia>
                <EmptyTitle>No sandboxes configured</EmptyTitle>
                <EmptyDescription>
                  Create a sandbox for an ACP Remote agent.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Agent</TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead>Workspace</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-36 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sandboxes.map((sandbox) => (
                  <TableRow key={sandbox.id}>
                    <TableCell className="font-medium">
                      <div>{sandbox.name}</div>
                      {sandbox.providerInstanceId && (
                        <div className="mt-0.5 truncate text-xs text-muted-foreground">
                          {sandbox.providerInstanceId}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>{agentName(sandbox.agentId, agents)}</TableCell>
                    <TableCell>{sandbox.provider}</TableCell>
                    <TableCell>
                      <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                        {sandbox.spec.workspace?.path ?? "/workspace"}
                      </code>
                    </TableCell>
                    <TableCell>
                      <Badge variant={statusVariant(sandbox.status)}>
                        {sandbox.status}
                      </Badge>
                      {sandbox.lastError && (
                        <div className="mt-1 max-w-xs truncate text-xs text-destructive">
                          {sandbox.lastError}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          aria-label={`Refresh ${sandbox.name}`}
                          onClick={() => void handleRefresh(sandbox.id)}
                          size="icon"
                          type="button"
                          variant="ghost"
                        >
                          <RefreshCw />
                        </Button>
                        {sandbox.status === "running" ||
                        sandbox.status === "starting" ? (
                          <Button
                            aria-label={`Stop ${sandbox.name}`}
                            onClick={() => void handleStop(sandbox.id)}
                            size="icon"
                            type="button"
                            variant="ghost"
                          >
                            <Square />
                          </Button>
                        ) : (
                          <Button
                            aria-label={`Start ${sandbox.name}`}
                            onClick={() => void handleStart(sandbox.id)}
                            size="icon"
                            type="button"
                            variant="ghost"
                          >
                            <Play />
                          </Button>
                        )}
                        <Button
                          aria-label={`Delete ${sandbox.name}`}
                          onClick={() => void handleDelete(sandbox.id)}
                          size="icon"
                          type="button"
                          variant="ghost"
                        >
                          <Trash2 />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>New Sandbox</DialogTitle>
            <DialogDescription>
              Provision an aio-sandbox runtime for an ACP Remote agent.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <ShadcnField>
              <FieldLabel>Name</FieldLabel>
              <Input
                value={form.name}
                onChange={(event) =>
                  setForm({ ...form, name: event.target.value })
                }
                placeholder="codex-prod"
              />
            </ShadcnField>
            <ShadcnField>
              <FieldLabel>ACP Remote Agent</FieldLabel>
              <Select
                value={form.agentId}
                onValueChange={(agentId) => setForm({ ...form, agentId })}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select an agent" />
                </SelectTrigger>
                <SelectContent>
                  {remoteAgents.map((agent) => (
                    <SelectItem key={agent.id} value={agent.id}>
                      {agent.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </ShadcnField>
            <div className="grid gap-3 sm:grid-cols-3">
              <ShadcnField>
                <FieldLabel>Image</FieldLabel>
                <Input
                  value={form.image}
                  onChange={(event) =>
                    setForm({ ...form, image: event.target.value })
                  }
                  placeholder="default"
                />
              </ShadcnField>
              <ShadcnField>
                <FieldLabel>Workspace</FieldLabel>
                <Input
                  value={form.workspacePath}
                  onChange={(event) =>
                    setForm({ ...form, workspacePath: event.target.value })
                  }
                />
              </ShadcnField>
              <ShadcnField>
                <FieldLabel>TTL Seconds</FieldLabel>
                <Input
                  inputMode="numeric"
                  value={form.ttlSeconds}
                  onChange={(event) =>
                    setForm({ ...form, ttlSeconds: event.target.value })
                  }
                />
              </ShadcnField>
            </div>
            <ShadcnField>
              <FieldLabel>Initialization Script</FieldLabel>
              <Textarea
                className="min-h-40 font-mono text-xs"
                value={form.initScript}
                onChange={(event) =>
                  setForm({ ...form, initScript: event.target.value })
                }
                placeholder={'set -euo pipefail\ncd "{{workspace.path}}"\ngit clone https://example/repo.git repo'}
              />
            </ShadcnField>
          </FieldGroup>
          <div className="flex justify-end gap-2">
            <Button
              onClick={() => setShowCreate(false)}
              type="button"
              variant="outline"
            >
              Cancel
            </Button>
            <Button
              disabled={!canSubmit || saving}
              onClick={() => void handleCreate()}
              type="button"
            >
              Create
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function toSpec(form: SandboxFormState): SandboxSpec {
  return {
    ...(form.image.trim() ? { image: form.image.trim() } : {}),
    workspace: { path: form.workspacePath.trim() || "/workspace" },
    ...(form.ttlSeconds.trim()
      ? { ttlSeconds: Number(form.ttlSeconds.trim()) }
      : {}),
    ...(form.initScript.trim()
      ? {
          initScript: {
            shell: "bash",
            content: form.initScript,
          },
        }
      : {}),
    relay: { restartPolicy: "always" },
  };
}

function positiveInteger(value: string): boolean {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0;
}

function agentName(agentId: string, agents: AgentConfig[]): string {
  return agents.find((agent) => agent.id === agentId)?.name ?? agentId;
}

function statusVariant(
  status: Sandbox["status"],
): "success" | "secondary" | "destructive" | "outline" {
  if (status === "running") return "success";
  if (status === "failed") return "destructive";
  if (status === "starting" || status === "stopping") return "secondary";
  return "outline";
}
