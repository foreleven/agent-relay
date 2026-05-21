import type { PluginRuntime } from "openclaw/plugin-sdk";

type PluginRuntimeMedia = PluginRuntime["media"];
type PluginRuntimeTts = PluginRuntime["tts"];
type PluginRuntimeMediaUnderstanding = PluginRuntime["mediaUnderstanding"];

/**
 * Build the `media` surface of a `PluginRuntime`.
 * All methods are stubs — the gateway does not process media files.
 */
export function buildMediaCompat(): PluginRuntimeMedia {
  const stub: PluginRuntimeMedia = {
    loadWebMedia: async () => {
      throw new Error("media.loadWebMedia not supported");
    },
    detectMime: async () => undefined,
    mediaKindFromMime: () => undefined,
    isVoiceCompatibleAudio: () => false,
    getImageMetadata: async () => null,
    resizeToJpeg: async () =>
      Buffer.alloc(0) as Awaited<
        ReturnType<PluginRuntimeMedia["resizeToJpeg"]>
      >,
  };
  return stub;
}

/**
 * Build the `tts` surface of a `PluginRuntime`.
 * All methods are stubs — the gateway does not synthesize speech.
 */
export function buildTtsCompat(): PluginRuntimeTts {
  return {
    textToSpeech: async () => ({ success: false }),
    textToSpeechStream: async () => ({ success: false }),
    textToSpeechTelephony: async () => ({ success: false }),
    listVoices: async () => [],
  };
}

/**
 * Build the `mediaUnderstanding` surface of a `PluginRuntime`.
 * All methods are stubs — the gateway does not perform media understanding.
 */
export function buildMediaUnderstandingCompat(): PluginRuntimeMediaUnderstanding {
  return {
    runFile: async () => ({ text: undefined }),
    describeImageFile: async () => ({ text: undefined }),
    describeImageFileWithModel: async () => ({ text: "" }),
    extractStructuredWithModel: async () => ({ text: "" }),
    describeVideoFile: async () => ({ text: undefined }),
    transcribeAudioFile: async () => ({ text: undefined }),
  };
}
