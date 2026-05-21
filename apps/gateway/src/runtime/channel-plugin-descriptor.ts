import { readFile, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

type JsonRecord = Record<string, unknown>;

export interface OpenClawChannelPackageDescriptorData {
  pluginId: string;
  packageName: string;
  channelIds: string[];
  aliases: string[];
  extensionSpecifiers: string[];
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function readJsonFile(filePath: string): JsonRecord {
  return JSON.parse(readFileSync(filePath, "utf8")) as JsonRecord;
}

const readFileAsync = promisify(readFile);

async function readJsonFileAsync(filePath: string): Promise<JsonRecord> {
  return JSON.parse(await readFileAsync(filePath, "utf8")) as JsonRecord;
}

export class OpenClawChannelPackageDescriptor {
  readonly pluginId: string;
  readonly packageName: string;
  readonly channelIds: string[];
  readonly aliases: string[];
  readonly extensionSpecifiers: string[];

  private constructor(data: OpenClawChannelPackageDescriptorData) {
    this.pluginId = data.pluginId;
    this.packageName = data.packageName;
    this.channelIds = data.channelIds;
    this.aliases = data.aliases;
    this.extensionSpecifiers = data.extensionSpecifiers;
  }

  static fromPackageRoot(packageRoot: string): OpenClawChannelPackageDescriptor {
    const packageJson = readJsonFile(join(packageRoot, "package.json"));
    const pluginJson = readJsonFile(join(packageRoot, "openclaw.plugin.json"));
    return OpenClawChannelPackageDescriptor.fromJson(packageRoot, {
      packageJson,
      pluginJson,
    });
  }

  static async fromPackageRootAsync(
    packageRoot: string,
  ): Promise<OpenClawChannelPackageDescriptor> {
    const [packageJson, pluginJson] = await Promise.all([
      readJsonFileAsync(join(packageRoot, "package.json")),
      readJsonFileAsync(join(packageRoot, "openclaw.plugin.json")),
    ]);
    return OpenClawChannelPackageDescriptor.fromJson(packageRoot, {
      packageJson,
      pluginJson,
    });
  }

  private static fromJson(
    packageRoot: string,
    files: {
      packageJson: JsonRecord;
      pluginJson: JsonRecord;
    },
  ): OpenClawChannelPackageDescriptor {
    const { packageJson, pluginJson } = files;
    const openclaw = asRecord(packageJson["openclaw"]);
    const packageChannel = asRecord(openclaw["channel"]);

    const packageChannelId = asString(packageChannel["id"]);
    const pluginId =
      asString(pluginJson["id"]) ??
      asString(openclaw["id"]) ??
      packageChannelId ??
      asString(packageJson["name"]);
    if (!pluginId) {
      throw new Error(
        `OpenClaw channel package at ${packageRoot} is missing a plugin id`,
      );
    }

    const channelIds = asStringArray(pluginJson["channels"]);
    const resolvedChannelIds =
      channelIds.length > 0
        ? channelIds
        : packageChannelId
          ? [packageChannelId]
          : [pluginId];
    const runtimeExtensionSpecifiers = asStringArray(
      openclaw["runtimeExtensions"],
    );
    const sourceExtensionSpecifiers = asStringArray(openclaw["extensions"]);

    return new OpenClawChannelPackageDescriptor({
      pluginId,
      packageName: asString(packageJson["name"]) ?? pluginId,
      channelIds: [...new Set(resolvedChannelIds)],
      aliases: [...new Set(asStringArray(packageChannel["aliases"]))],
      extensionSpecifiers:
        runtimeExtensionSpecifiers.length > 0
          ? runtimeExtensionSpecifiers
          : sourceExtensionSpecifiers,
    });
  }
}
