import type { PluginRuntime } from "openclaw/plugin-sdk";

type PluginRuntimeState = PluginRuntime["state"];
type OpenKeyedStoreOptions = Parameters<PluginRuntimeState["openKeyedStore"]>[0];

type PluginStateEntry<T> = {
  key: string;
  value: T;
  createdAt: number;
  expiresAt?: number;
};

type PluginStateKeyedStore<T> = {
  register(key: string, value: T, opts?: { ttlMs?: number }): Promise<void>;
  registerIfAbsent(
    key: string,
    value: T,
    opts?: { ttlMs?: number },
  ): Promise<boolean>;
  lookup(key: string): Promise<T | undefined>;
  consume(key: string): Promise<T | undefined>;
  delete(key: string): Promise<boolean>;
  entries(): Promise<PluginStateEntry<T>[]>;
  clear(): Promise<void>;
};

type StoredPluginStateEntry = {
  key: string;
  value: unknown;
  createdAt: number;
  expiresAt?: number;
};

export function buildStateCompat(): PluginRuntimeState {
  const keyedStoreManager = new InMemoryKeyedStoreManager();

  return {
    resolveStateDir: () => "/tmp/agent-relay",
    openKeyedStore: <T>(options: OpenKeyedStoreOptions) =>
      keyedStoreManager.open<T>(options),
  };
}

class InMemoryKeyedStoreManager {
  private readonly stores = new Map<string, Map<string, StoredPluginStateEntry>>();

  open<T>(options: OpenKeyedStoreOptions): PluginStateKeyedStore<T> {
    const normalized = normalizeOpenKeyedStoreOptions(options);
    let entries = this.stores.get(normalized.namespace);
    if (!entries) {
      entries = new Map<string, StoredPluginStateEntry>();
      this.stores.set(normalized.namespace, entries);
    }

    return new InMemoryPluginStateKeyedStore<T>(entries, normalized);
  }
}

class InMemoryPluginStateKeyedStore<T> implements PluginStateKeyedStore<T> {
  constructor(
    private readonly entriesByKey: Map<string, StoredPluginStateEntry>,
    private readonly options: Required<
      Pick<OpenKeyedStoreOptions, "namespace" | "maxEntries">
    > &
      Pick<OpenKeyedStoreOptions, "defaultTtlMs">,
  ) {}

  async register(
    key: string,
    value: T,
    opts: { ttlMs?: number } = {},
  ): Promise<void> {
    const normalizedKey = normalizeKey(key);
    this.sweepExpired();
    this.ensureCapacityFor(normalizedKey);
    this.entriesByKey.set(
      normalizedKey,
      this.createEntry(normalizedKey, value, opts),
    );
  }

  async registerIfAbsent(
    key: string,
    value: T,
    opts: { ttlMs?: number } = {},
  ): Promise<boolean> {
    const normalizedKey = normalizeKey(key);
    this.sweepExpired();
    if (this.entriesByKey.has(normalizedKey)) {
      return false;
    }

    this.ensureCapacityFor(normalizedKey);
    this.entriesByKey.set(
      normalizedKey,
      this.createEntry(normalizedKey, value, opts),
    );
    return true;
  }

  async lookup(key: string): Promise<T | undefined> {
    const normalizedKey = normalizeKey(key);
    const entry = this.readLiveEntry(normalizedKey);
    return entry ? cloneValue(entry.value as T) : undefined;
  }

  async consume(key: string): Promise<T | undefined> {
    const normalizedKey = normalizeKey(key);
    const entry = this.readLiveEntry(normalizedKey);
    if (!entry) {
      return undefined;
    }

    this.entriesByKey.delete(normalizedKey);
    return cloneValue(entry.value as T);
  }

  async delete(key: string): Promise<boolean> {
    return this.entriesByKey.delete(normalizeKey(key));
  }

  async entries(): Promise<PluginStateEntry<T>[]> {
    this.sweepExpired();
    return Array.from(this.entriesByKey.values()).map((entry) => ({
      key: entry.key,
      value: cloneValue(entry.value as T),
      createdAt: entry.createdAt,
      ...(entry.expiresAt !== undefined ? { expiresAt: entry.expiresAt } : {}),
    }));
  }

  async clear(): Promise<void> {
    this.entriesByKey.clear();
  }

  private createEntry(
    key: string,
    value: T,
    opts: { ttlMs?: number },
  ): StoredPluginStateEntry {
    const createdAt = Date.now();
    const ttlMs = opts.ttlMs ?? this.options.defaultTtlMs;
    return {
      key,
      value: cloneValue(value),
      createdAt,
      ...(ttlMs !== undefined ? { expiresAt: createdAt + ttlMs } : {}),
    };
  }

  private ensureCapacityFor(key: string): void {
    if (this.entriesByKey.has(key)) {
      return;
    }

    while (this.entriesByKey.size >= this.options.maxEntries) {
      const oldestKey = this.entriesByKey.keys().next().value as
        | string
        | undefined;
      if (!oldestKey) {
        break;
      }
      this.entriesByKey.delete(oldestKey);
    }
  }

  private readLiveEntry(key: string): StoredPluginStateEntry | undefined {
    const entry = this.entriesByKey.get(key);
    if (!entry) {
      return undefined;
    }
    if (isExpired(entry)) {
      this.entriesByKey.delete(key);
      return undefined;
    }
    return entry;
  }

  private sweepExpired(): void {
    for (const [key, entry] of this.entriesByKey) {
      if (isExpired(entry)) {
        this.entriesByKey.delete(key);
      }
    }
  }
}

function normalizeOpenKeyedStoreOptions(
  options: OpenKeyedStoreOptions,
): Required<Pick<OpenKeyedStoreOptions, "namespace" | "maxEntries">> &
  Pick<OpenKeyedStoreOptions, "defaultTtlMs"> {
  const namespace = options.namespace.trim();
  if (!namespace) {
    throw new Error("openKeyedStore namespace must be a non-empty string");
  }
  if (!Number.isInteger(options.maxEntries) || options.maxEntries < 1) {
    throw new Error("openKeyedStore maxEntries must be a positive integer");
  }
  if (
    options.defaultTtlMs !== undefined &&
    (!Number.isFinite(options.defaultTtlMs) || options.defaultTtlMs < 0)
  ) {
    throw new Error("openKeyedStore defaultTtlMs must be non-negative");
  }

  return {
    namespace,
    maxEntries: options.maxEntries,
    ...(options.defaultTtlMs !== undefined
      ? { defaultTtlMs: options.defaultTtlMs }
      : {}),
  };
}

function normalizeKey(key: string): string {
  const normalized = key.trim();
  if (!normalized) {
    throw new Error("openKeyedStore key must be a non-empty string");
  }
  return normalized;
}

function isExpired(entry: StoredPluginStateEntry): boolean {
  return entry.expiresAt !== undefined && entry.expiresAt <= Date.now();
}

function cloneValue<T>(value: T): T {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}
