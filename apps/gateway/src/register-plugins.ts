/**
 * Channel plugin registrations for the gateway.
 *
 * Add one registerXxxPlugin(host) call per OpenClaw channel plugin that
 * should be active.  No per-channel package is required – any community
 * plugin that conforms to the OpenClaw plugin API can be wired up here.
 */

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { OpenClawPluginHost } from "@agent-relay/openclaw-compat";
import type {
  ChannelPlugin,
  OpenClawPluginApi,
} from "openclaw/plugin-sdk";
import { inject, injectable } from "inversify";

import type { ServiceContribution } from "./bootstrap/service-contribution.js";
import {
  createSilentGatewayLogger,
  GatewayLogger,
  type GatewayLogger as GatewayLoggerPort,
} from "./infra/logger.js";
import { OpenClawChannelPackageDescriptor } from "./runtime/channel-plugin-descriptor.js";
import { channelTypeRegistry } from "./runtime/channel-type-registry.js";

type BundledPackageChannelRegistration = {
  kind: "package-bundled";
  packageName: string;
  pluginSpecifier: string;
  pluginExportName: string;
  runtimeSpecifier?: string;
  runtimeExportName?: string;
};

type BundledOpenClawChannelRegistration = {
  kind: "openclaw-bundled";
  channelId: "telegram";
};

type DirectPackageChannelRegistration = {
  kind: "direct-package";
  packageName: string;
};

type ChannelRegistration =
  | BundledPackageChannelRegistration
  | BundledOpenClawChannelRegistration
  | DirectPackageChannelRegistration;

type RegisterablePlugin = {
  register(api: OpenClawPluginApi): void;
};

const require = createRequire(import.meta.url);

type BundledEntryReference = {
  specifier: string;
  exportName: string;
};

type PreparedChannelRegistration = {
  descriptor: OpenClawChannelPackageDescriptor;
  label: string;
  plugin: RegisterablePlugin;
};

function resolveOpenClawDistDir(): string {
  const channelEntryContractPath = require.resolve(
    "openclaw/plugin-sdk/channel-entry-contract",
  );
  return dirname(dirname(channelEntryContractPath));
}

function resolvePackageRoot(packageName: string): string {
  return dirname(require.resolve(`${packageName}/package.json`));
}

function resolveOpenClawExtensionRoot(channelId: "telegram"): string {
  return join(resolveOpenClawDistDir(), "extensions", channelId);
}

async function readOpenClawBundledChannelDescriptorAsync(
  channelId: BundledOpenClawChannelRegistration["channelId"],
): Promise<OpenClawChannelPackageDescriptor> {
  return OpenClawChannelPackageDescriptor.fromPackageRootAsync(
    resolveOpenClawExtensionRoot(channelId),
  );
}

async function readPackageChannelDescriptorAsync(
  packageName: string,
): Promise<OpenClawChannelPackageDescriptor> {
  return OpenClawChannelPackageDescriptor.fromPackageRootAsync(
    resolvePackageRoot(packageName),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function resolveLoadedModuleExport(
  loadedModule: unknown,
  reference: BundledEntryReference,
): unknown {
  const resolved =
    isRecord(loadedModule) && "default" in loadedModule
      ? loadedModule["default"]
      : loadedModule;
  const exportSource = isRecord(resolved)
    ? resolved
    : isRecord(loadedModule)
      ? loadedModule
      : undefined;

  if (!exportSource || !(reference.exportName in exportSource)) {
    throw new Error(
      `missing export "${reference.exportName}" from bundled entry module ${reference.specifier}`,
    );
  }
  return exportSource[reference.exportName];
}

function toChannelPlugin(value: unknown, label: string): ChannelPlugin {
  if (!isRecord(value) || typeof value["id"] !== "string") {
    throw new Error(`${label} did not export a valid OpenClaw channel plugin`);
  }
  return value as ChannelPlugin;
}

function toRegisterablePlugin(value: unknown, label: string): RegisterablePlugin {
  if (!isRecord(value) || typeof value["register"] !== "function") {
    throw new Error(`${label} did not export a valid OpenClaw plugin`);
  }
  const register = value["register"];
  return {
    register(api) {
      register(api);
    },
  };
}

function toRuntimeSetter(
  value: unknown,
  label: string,
): (runtime: OpenClawPluginApi["runtime"]) => void {
  if (typeof value !== "function") {
    throw new Error(`${label} did not export a valid runtime setter`);
  }
  return (runtime) => {
    value(runtime);
  };
}

async function importBundledExport(
  importMetaUrl: string,
  reference: BundledEntryReference,
): Promise<unknown> {
  const loadedModule = await import(
    new URL(reference.specifier, importMetaUrl).href
  );
  return resolveLoadedModuleExport(loadedModule, reference);
}

async function importDirectPackagePlugin(
  registration: DirectPackageChannelRegistration,
): Promise<RegisterablePlugin> {
  const loadedModule = await import(registration.packageName);
  const resolved =
    isRecord(loadedModule) && "default" in loadedModule
      ? loadedModule["default"]
      : loadedModule;
  return toRegisterablePlugin(resolved, registration.packageName);
}

async function buildLoadedBundledChannelEntry(params: {
  importMetaUrl: string;
  label: string;
  plugin: BundledEntryReference;
  runtime?: BundledEntryReference;
}): Promise<RegisterablePlugin> {
  const [pluginExport, runtimeExport] = await Promise.all([
    importBundledExport(params.importMetaUrl, params.plugin),
    params.runtime
      ? importBundledExport(params.importMetaUrl, params.runtime)
      : Promise.resolve(undefined),
  ]);
  const channelPlugin = toChannelPlugin(pluginExport, params.label);
  const setRuntime = runtimeExport
    ? toRuntimeSetter(runtimeExport, params.label)
    : undefined;

  return {
    register(api) {
      api.registerChannel({ plugin: channelPlugin });
      setRuntime?.(api.runtime);
    },
  };
}

async function buildPackageBundledChannelEntry(
  registration: BundledPackageChannelRegistration,
  descriptor: OpenClawChannelPackageDescriptor,
): Promise<RegisterablePlugin> {
  const extensionSpecifier = descriptor.extensionSpecifiers[0] ?? "./index.ts";
  const importMetaUrl = pathToFileURL(
    join(resolvePackageRoot(registration.packageName), extensionSpecifier),
  ).href;

  return buildLoadedBundledChannelEntry({
    importMetaUrl,
    label: registration.packageName,
    plugin: {
      specifier: registration.pluginSpecifier,
      exportName: registration.pluginExportName,
    },
    runtime:
      registration.runtimeSpecifier && registration.runtimeExportName
        ? {
            specifier: registration.runtimeSpecifier,
            exportName: registration.runtimeExportName,
          }
        : undefined,
  });
}

async function buildOpenClawBundledChannelEntry(
  registration: BundledOpenClawChannelRegistration,
  descriptor: OpenClawChannelPackageDescriptor,
): Promise<RegisterablePlugin> {
  const extensionSpecifier = descriptor.extensionSpecifiers[0] ?? "./index.js";
  const importMetaUrl = pathToFileURL(
    join(
      resolveOpenClawExtensionRoot(registration.channelId),
      extensionSpecifier,
    ),
  ).href;

  return buildLoadedBundledChannelEntry({
    importMetaUrl,
    label: `openclaw/${registration.channelId}`,
    plugin: {
      specifier: "./channel-plugin-api.js",
      exportName: `${registration.channelId}Plugin`,
    },
  });
}

function registerPlugin(
  host: OpenClawPluginHost,
  plugin: RegisterablePlugin,
  label: string,
  logger: Pick<GatewayLoggerPort, "info">,
): void {
  host.registerPlugin((api) => plugin.register(api));
  logger.info({ label }, "channel plugin registered");
}

function registerMetadataAliases(
  host: OpenClawPluginHost,
  descriptor: OpenClawChannelPackageDescriptor,
): void {
  const targetChannelId = descriptor.channelIds[0] ?? descriptor.pluginId;
  const aliases = new Set<string>([
    ...descriptor.channelIds,
    ...descriptor.aliases,
    ...channelTypeRegistry.aliasesFor(targetChannelId),
  ]);

  aliases.delete(targetChannelId);
  for (const alias of aliases) {
    host.registerChannelAlias(alias, targetChannelId);
  }
}

async function prepareDirectPackagePlugin(
  registration: DirectPackageChannelRegistration,
): Promise<PreparedChannelRegistration> {
  return {
    descriptor: await readPackageChannelDescriptorAsync(registration.packageName),
    label: registration.packageName,
    plugin: await importDirectPackagePlugin(registration),
  };
}

async function prepareBundledPackagePlugin(
  registration: BundledPackageChannelRegistration,
): Promise<PreparedChannelRegistration> {
  const descriptor = await readPackageChannelDescriptorAsync(
    registration.packageName,
  );
  return {
    descriptor,
    label: registration.packageName,
    plugin: await buildPackageBundledChannelEntry(registration, descriptor),
  };
}

async function prepareBundledOpenClawPlugin(
  registration: BundledOpenClawChannelRegistration,
): Promise<PreparedChannelRegistration> {
  const descriptor = await readOpenClawBundledChannelDescriptorAsync(
    registration.channelId,
  );
  return {
    descriptor,
    label: `openclaw/${registration.channelId}`,
    plugin: await buildOpenClawBundledChannelEntry(registration, descriptor),
  };
}

function prepareChannelPlugin(
  registration: ChannelRegistration,
): Promise<PreparedChannelRegistration> {
  if (registration.kind === "direct-package") {
    return prepareDirectPackagePlugin(registration);
  }
  if (registration.kind === "openclaw-bundled") {
    return prepareBundledOpenClawPlugin(registration);
  }
  return prepareBundledPackagePlugin(registration);
}

function registerPreparedChannelPlugin(
  host: OpenClawPluginHost,
  prepared: PreparedChannelRegistration,
  logger: Pick<GatewayLoggerPort, "info">,
): void {
  registerPlugin(host, prepared.plugin, prepared.label, logger);
  registerMetadataAliases(host, prepared.descriptor);
}

const channelRegistrations: ChannelRegistration[] = [
  {
    kind: "package-bundled",
    packageName: "@openclaw/feishu",
    pluginSpecifier: "./channel-plugin-api.js",
    pluginExportName: "feishuPlugin",
    runtimeSpecifier: "./runtime-api.js",
    runtimeExportName: "setFeishuRuntime",
  },
  {
    kind: "package-bundled",
    packageName: "@openclaw/discord",
    pluginSpecifier: "./channel-plugin-api.js",
    pluginExportName: "discordPlugin",
    runtimeSpecifier: "./runtime-setter-api.js",
    runtimeExportName: "setDiscordRuntime",
  },
  {
    kind: "package-bundled",
    packageName: "@openclaw/slack",
    pluginSpecifier: "./channel-plugin-api.js",
    pluginExportName: "slackPlugin",
    runtimeSpecifier: "./runtime-setter-api.js",
    runtimeExportName: "setSlackRuntime",
  },
  { kind: "openclaw-bundled", channelId: "telegram" },
  {
    kind: "package-bundled",
    packageName: "@openclaw/whatsapp",
    pluginSpecifier: "./channel-plugin-api.js",
    pluginExportName: "whatsappPlugin",
    runtimeSpecifier: "./runtime-api.js",
    runtimeExportName: "setWhatsAppRuntime",
  },
  {
    kind: "direct-package",
    packageName: "@openclaw/weixin",
  },
  {
    kind: "package-bundled",
    packageName: "@openclaw/qqbot",
    pluginSpecifier: "./channel-plugin-api.js",
    pluginExportName: "qqbotPlugin",
    runtimeSpecifier: "./runtime-api.js",
    runtimeExportName: "setQQBotRuntime",
  },
];

// ---------------------------------------------------------------------------
// Register all plugins with the host
// ---------------------------------------------------------------------------

export async function registerAllPlugins(
  host: OpenClawPluginHost,
  logger: Pick<GatewayLoggerPort, "info"> = createSilentGatewayLogger(),
): Promise<void> {
  const preparedRegistrations = await Promise.all(
    channelRegistrations.map((registration) =>
      prepareChannelPlugin(registration),
    ),
  );

  for (const prepared of preparedRegistrations) {
    registerPreparedChannelPlugin(host, prepared, logger);
  }
}

@injectable()
export class PluginRegistrationService implements ServiceContribution {
  private registered = false;

  constructor(
    @inject(OpenClawPluginHost)
    private readonly host: OpenClawPluginHost,
    @inject(GatewayLogger)
    private readonly logger: GatewayLoggerPort = createSilentGatewayLogger(),
  ) {}

  async start(): Promise<void> {
    if (this.registered) return;
    await registerAllPlugins(this.host, this.logger);
    this.registered = true;
  }

  async stop(): Promise<void> {}
}
