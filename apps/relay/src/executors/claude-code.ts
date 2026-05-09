/**
 * ClaudeCodeExecutor
 *
 * Executes messages by spawning the `claude` CLI process in non-interactive
 * (`--print`) mode.  Configuration (model, system prompt, max turns, allowed
 * tools) is applied as CLI flags.
 *
 * The `claude` binary is resolved in order:
 *  1. The local `@anthropic-ai/claude-code` package installed alongside this
 *     CLI (i.e. in node_modules).
 *  2. The `CLAUDE_BIN` environment variable.
 *  3. `claude` on PATH.
 */

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import type { ClaudeCodeExecutorConfig } from "../types.js";

// ---------------------------------------------------------------------------
// Binary resolution
// ---------------------------------------------------------------------------

function resolveClaudeCodeBin(): string {
  // 1. Environment variable override
  if (process.env["CLAUDE_BIN"]) {
    return process.env["CLAUDE_BIN"];
  }

  // 2. Local package install
  try {
    const require = createRequire(fileURLToPath(import.meta.url));
    const pkgPath = require.resolve("@anthropic-ai/claude-code/package.json");
    const pkgDir = dirname(pkgPath);
    // The package installs a platform-specific binary at bin/claude (or claude.exe on win32)
    const binName = process.platform === "win32" ? "claude.exe" : "claude";
    return join(pkgDir, "bin", binName);
  } catch {
    // Not installed locally – fall through to PATH
  }

  // 3. Assume it's on PATH
  return "claude";
}

// ---------------------------------------------------------------------------
// Executor class
// ---------------------------------------------------------------------------

/**
 * Wraps the `claude` CLI binary to execute A2A-style text prompts without an
 * interactive terminal.
 */
export class ClaudeCodeExecutor {
  private readonly claudeBin: string;

  constructor(private readonly config: ClaudeCodeExecutorConfig) {
    this.claudeBin = resolveClaudeCodeBin();
  }

  /**
   * Runs the given message through Claude Code and returns the complete text
   * response.
   *
   * Throws an error if the `claude` process exits with a non-zero code.
   */
  async execute(message: string): Promise<string> {
    const args = this.buildArgs(message);

    return new Promise<string>((resolve, reject) => {
      const proc = spawn(this.claudeBin, args, {
        env: {
          ...process.env,
          // Claude Code needs a home directory for config; forward relevant vars.
        },
        // Do not inherit a TTY – we capture stdout/stderr directly.
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      proc.stdout.setEncoding("utf8");
      proc.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });

      proc.stderr.setEncoding("utf8");
      proc.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });

      proc.on("error", (err) => {
        reject(
          new Error(
            `Failed to spawn claude executor: ${err.message}. ` +
              `Is @anthropic-ai/claude-code installed? (run: npm install -g @anthropic-ai/claude-code)`,
          ),
        );
      });

      proc.on("close", (code) => {
        if (code === 0) {
          resolve(stdout.trim());
        } else {
          reject(
            new Error(
              `claude exited with code ${code}.\nstderr: ${stderr.trim()}`,
            ),
          );
        }
      });

      // Close stdin immediately since the message is passed as a CLI argument.
      if (proc.stdin) {
        proc.stdin.end();
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private buildArgs(message: string): string[] {
    const args: string[] = [
      // Non-interactive output mode: print the response and exit
      "--print",
      message,
    ];

    if (this.config.model) {
      args.push("--model", this.config.model);
    }

    if (
      this.config.maxTurns !== undefined &&
      this.config.maxTurns !== null
    ) {
      args.push("--max-turns", String(this.config.maxTurns));
    }

    if (this.config.systemPrompt) {
      args.push("--system-prompt", this.config.systemPrompt);
    }

    if (this.config.allowedTools && this.config.allowedTools.length > 0) {
      args.push("--allowedTools", this.config.allowedTools.join(","));
    }

    return args;
  }
}
