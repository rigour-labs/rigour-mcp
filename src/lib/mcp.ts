import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { GateRunner, ConfigSchema, RetryLoopBreakerGate } from "@rigour-labs/core";
import fs from "node:fs/promises";
import path from "node:path";
import yaml from "yaml";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";

type JsonMap = Record<string, unknown>;

type ToolResponse = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

const HOSTED_MODE = process.env.RIGOUR_MCP_MODE === "hybrid_executor" ? "hybrid_executor" : "control_plane";
const WORKSPACE_ROOT = path.resolve(process.env.RIGOUR_WORKSPACE_ROOT || "/tmp/rigour-workspaces");

const LOCAL_ONLY_TOOLS = new Set<string>([
  "rigour_check",
  "rigour_check_deep",
  "rigour_review",
  "rigour_security_audit",
  "rigour_hooks_init",
  "rigour_hooks_check",
  "rigour_list_gates",
  "rigour_get_config",
  "rigour_check_pattern",
  "rigour_deep_stats",
]);

function getObject(value: unknown): JsonMap {
  return value && typeof value === "object" ? (value as JsonMap) : {};
}

function getStringArg(args: JsonMap, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function getBooleanArg(args: JsonMap, key: string): boolean | undefined {
  const value = args[key];
  return typeof value === "boolean" ? value : undefined;
}

function getStringArrayArg(args: JsonMap, key: string): string[] {
  const value = args[key];
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => v.trim());
}

function sanitizeArgs(args: JsonMap): JsonMap {
  const out: JsonMap = {};
  for (const [key, value] of Object.entries(args)) {
    const lower = key.toLowerCase();
    if (lower.includes("key") || lower.includes("token") || lower.includes("secret") || lower.includes("password")) {
      out[key] = "[REDACTED]";
      continue;
    }
    if (typeof value === "string" && value.length > 300) {
      out[key] = `${value.slice(0, 300)}...`;
      continue;
    }
    out[key] = value;
  }
  return out;
}

function localExecutionRequired(tool: string): ToolResponse {
  return {
    content: [
      {
        type: "text",
        text:
          `LOCAL_EXECUTION_REQUIRED: ${tool} requires local repository filesystem access.\n\n` +
          `Use local MCP in your agent config:\n` +
          `{"mcpServers":{"rigour":{"command":"npx","args":["-y","@rigour-labs/mcp"]}}}`,
      },
    ],
    isError: true,
  };
}

function resolveWorkspaceCwd(args: JsonMap): string {
  const raw = getStringArg(args, "cwd");
  if (!raw) {
    throw new Error("Missing required argument: cwd");
  }

  const candidate = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(WORKSPACE_ROOT, raw);
  const normalizedRoot = WORKSPACE_ROOT.endsWith(path.sep) ? WORKSPACE_ROOT : `${WORKSPACE_ROOT}${path.sep}`;

  if (!(candidate === WORKSPACE_ROOT || candidate.startsWith(normalizedRoot))) {
    throw new Error(`Invalid cwd. Must be under workspace root: ${WORKSPACE_ROOT}`);
  }

  return candidate;
}

async function ensureWorkspace(cwd: string): Promise<void> {
  await fs.mkdir(cwd, { recursive: true });
}

async function loadConfig(cwd: string) {
  const configPath = path.join(cwd, "rigour.yml");
  try {
    await fs.access(configPath);
  } catch {
    throw new Error(`Rigour configuration (rigour.yml) not found at ${configPath}. Run 'rigour init' first.`);
  }
  const configContent = await fs.readFile(configPath, "utf-8");
  return ConfigSchema.parse(yaml.parse(configContent));
}

function parseJsonOrNull<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

async function runCommand(cwd: string, command: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return await new Promise((resolve) => {
    execFile(command, args, { cwd, env: process.env, timeout: 120000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (!error) {
        resolve({ code: 0, stdout: stdout || "", stderr: stderr || "" });
        return;
      }
      const maybeCode = (error as NodeJS.ErrnoException).code;
      const code = typeof maybeCode === "number" ? maybeCode : 1;
      resolve({ code, stdout: stdout || "", stderr: stderr || "" });
    });
  });
}

async function runRigourCli(cwd: string, args: string[]) {
  const preferred = process.env.RIGOUR_CLI_PATH || "rigour";
  const first = await runCommand(cwd, preferred, args);
  if (first.code !== 127 && !/not found/i.test(first.stderr)) {
    return first;
  }

  return await runCommand(cwd, "npx", ["-y", "@rigour-labs/cli", ...args]);
}

async function logStudioEvent(cwd: string, event: JsonMap): Promise<void> {
  try {
    const rigourDir = path.join(cwd, ".rigour");
    await fs.mkdir(rigourDir, { recursive: true });
    const eventsPath = path.join(rigourDir, "events.jsonl");
    const logEntry =
      JSON.stringify({
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        ...event,
      }) + "\n";
    await fs.appendFile(eventsPath, logEntry);
  } catch {
    // silent fail
  }
}

interface MemoryStore {
  memories: Record<string, { value: string; timestamp: string }>;
}

async function getMemoryPath(cwd: string): Promise<string> {
  const rigourDir = path.join(cwd, ".rigour");
  await fs.mkdir(rigourDir, { recursive: true });
  return path.join(rigourDir, "memory.json");
}

async function loadMemory(cwd: string): Promise<MemoryStore> {
  const memPath = await getMemoryPath(cwd);
  try {
    const content = await fs.readFile(memPath, "utf-8");
    return JSON.parse(content) as MemoryStore;
  } catch {
    return { memories: {} };
  }
}

async function saveMemory(cwd: string, store: MemoryStore): Promise<void> {
  const memPath = await getMemoryPath(cwd);
  await fs.writeFile(memPath, JSON.stringify(store, null, 2));
}

const TOOL_DEFINITIONS = [
  {
    name: "rigour_check",
    description: "Run quality gate checks on the project. Matches CLI 'check'.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string", description: "Workspace id/path under server workspace root." },
        files: { type: "array", items: { type: "string" }, description: "Optional files subset." },
      },
      required: ["cwd"],
    },
  },
  {
    name: "rigour_check_deep",
    description: "Run deep analysis (deep/deep-pro, optional provider key).",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string" },
        pro: { type: "boolean" },
        provider: { type: "string" },
        apiKey: { type: "string" },
        apiBaseUrl: { type: "string" },
        modelName: { type: "string" },
      },
      required: ["cwd"],
    },
  },
  {
    name: "rigour_review",
    description: "PR-oriented review run; accepts diff/files, returns machine-readable failures.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string" },
        diff: { type: "string" },
        files: { type: "array", items: { type: "string" } },
      },
      required: ["cwd"],
    },
  },
  {
    name: "rigour_explain",
    description: "Explain last quality gate failures with actionable bullets.",
    inputSchema: {
      type: "object",
      properties: { cwd: { type: "string" } },
      required: ["cwd"],
    },
  },
  {
    name: "rigour_status",
    description: "Quick PASS/FAIL JSON-friendly summary.",
    inputSchema: {
      type: "object",
      properties: { cwd: { type: "string" } },
      required: ["cwd"],
    },
  },
  {
    name: "rigour_get_fix_packet",
    description: "Retrieve prioritized Fix Packet from latest run.",
    inputSchema: {
      type: "object",
      properties: { cwd: { type: "string" } },
      required: ["cwd"],
    },
  },
  {
    name: "rigour_security_audit",
    description: "Dependency vulnerability summary (npm audit backed).",
    inputSchema: {
      type: "object",
      properties: { cwd: { type: "string" } },
      required: ["cwd"],
    },
  },
  {
    name: "rigour_hooks_init",
    description: "Install Rigour hooks for agent IDE tools.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string" },
        tool: { type: "string" },
        force: { type: "boolean" },
        dryRun: { type: "boolean" },
      },
      required: ["cwd"],
    },
  },
  {
    name: "rigour_hooks_check",
    description: "Fast file checks from hook engine.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string" },
        files: { type: "array", items: { type: "string" } },
      },
      required: ["cwd"],
    },
  },
  {
    name: "rigour_list_gates",
    description: "List configured gates from rigour.yml.",
    inputSchema: {
      type: "object",
      properties: { cwd: { type: "string" } },
      required: ["cwd"],
    },
  },
  {
    name: "rigour_get_config",
    description: "Return parsed rigour configuration.",
    inputSchema: {
      type: "object",
      properties: { cwd: { type: "string" } },
      required: ["cwd"],
    },
  },
  {
    name: "rigour_check_pattern",
    description: "Check if pattern appears in recent failures.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string" },
        name: { type: "string" },
      },
      required: ["cwd", "name"],
    },
  },
  {
    name: "rigour_deep_stats",
    description: "Deep analysis trend summary from report/history files.",
    inputSchema: {
      type: "object",
      properties: { cwd: { type: "string" } },
      required: ["cwd"],
    },
  },
  {
    name: "rigour_record_failure",
    description: "Record an operation failure to track retry loops.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string" },
        errorMessage: { type: "string" },
        category: { type: "string" },
      },
      required: ["cwd", "errorMessage"],
    },
  },
  {
    name: "rigour_clear_failure",
    description: "Clear failure history for a category.",
    inputSchema: {
      type: "object",
      properties: { cwd: { type: "string" }, category: { type: "string" } },
      required: ["cwd", "category"],
    },
  },
  {
    name: "rigour_remember",
    description: "Store persistent memory/instruction.",
    inputSchema: {
      type: "object",
      properties: { cwd: { type: "string" }, key: { type: "string" }, value: { type: "string" } },
      required: ["cwd", "key", "value"],
    },
  },
  {
    name: "rigour_recall",
    description: "Recall one or all stored memories.",
    inputSchema: {
      type: "object",
      properties: { cwd: { type: "string" }, key: { type: "string" } },
      required: ["cwd"],
    },
  },
  {
    name: "rigour_forget",
    description: "Delete a memory key.",
    inputSchema: {
      type: "object",
      properties: { cwd: { type: "string" }, key: { type: "string" } },
      required: ["cwd", "key"],
    },
  },
];

export function createMcpServer() {
  const server = new Server(
    {
      name: "rigour-remote-mcp",
      version: "2.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFINITIONS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params;
    const args = getObject(rawArgs);
    const requestId = randomUUID();

    if (HOSTED_MODE === "control_plane" && LOCAL_ONLY_TOOLS.has(name)) {
      return localExecutionRequired(name);
    }

    let cwd: string;
    try {
      cwd = resolveWorkspaceCwd(args);
      await ensureWorkspace(cwd);
    } catch (error) {
      return {
        content: [{ type: "text", text: `RIGOUR ERROR: ${error instanceof Error ? error.message : "Invalid cwd"}` }],
        isError: true,
      };
    }

    await logStudioEvent(cwd, {
      type: "tool_call",
      requestId,
      tool: name,
      arguments: sanitizeArgs(args),
    });

    try {
      switch (name) {
        case "rigour_check": {
          const cfg = await loadConfig(cwd);
          const runner = new GateRunner(cfg);
          const files = getStringArrayArg(args, "files");
          const report = await runner.run(cwd, files.length > 0 ? files : undefined);
          return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
        }

        case "rigour_check_deep": {
          const cliArgs = ["check", "--json", "--deep"] as string[];
          if (getBooleanArg(args, "pro")) cliArgs.push("--pro");
          const provider = getStringArg(args, "provider");
          const apiKey = getStringArg(args, "apiKey");
          const apiBaseUrl = getStringArg(args, "apiBaseUrl");
          const modelName = getStringArg(args, "modelName");
          if (provider) cliArgs.push("--provider", provider);
          if (apiKey) cliArgs.push("--api-key", apiKey);
          if (apiBaseUrl) cliArgs.push("--api-base-url", apiBaseUrl);
          if (modelName) cliArgs.push("--model-name", modelName);

          const result = await runRigourCli(cwd, cliArgs);
          const parsed = parseJsonOrNull<unknown>(result.stdout);
          const payload = parsed ?? { code: result.code, stdout: result.stdout, stderr: result.stderr };
          return {
            content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
            isError: result.code !== 0 && result.code !== 1,
          };
        }

        case "rigour_review": {
          const cfg = await loadConfig(cwd);
          const runner = new GateRunner(cfg);
          const files = getStringArrayArg(args, "files");
          const report = await runner.run(cwd, files.length > 0 ? files : undefined);
          const diff = getStringArg(args, "diff");
          return {
            content: [{
              type: "text",
              text: JSON.stringify(
                {
                  status: report.status,
                  failures: report.failures,
                  summary: report.summary,
                  stats: report.stats,
                  note: diff ? "diff was provided; runner is currently file-scoped in hosted mode" : undefined,
                },
                null,
                2
              ),
            }],
          };
        }

        case "rigour_explain": {
          const cfg = await loadConfig(cwd);
          const runner = new GateRunner(cfg);
          const report = await runner.run(cwd);
          if (report.status === "PASS") {
            return { content: [{ type: "text", text: "ALL QUALITY GATES PASSED. No failures to explain." }] };
          }
          const bullets = report.failures
            .map((f, i) => `${i + 1}. [${f.id.toUpperCase()}] ${f.title}: ${f.details}${f.hint ? ` (Hint: ${f.hint})` : ""}`)
            .join("\n");
          return { content: [{ type: "text", text: `RIGOUR EXPLAIN:\n\n${bullets}` }] };
        }

        case "rigour_status": {
          const cfg = await loadConfig(cwd);
          const runner = new GateRunner(cfg);
          const report = await runner.run(cwd);
          return {
            content: [{
              type: "text",
              text: JSON.stringify(
                {
                  status: report.status,
                  summary: report.summary,
                  failureCount: report.failures.length,
                  durationMs: report.stats.duration_ms,
                },
                null,
                2
              ),
            }],
          };
        }

        case "rigour_get_fix_packet": {
          const filePath = path.join(cwd, "rigour-fix-packet.json");
          try {
            const packet = await fs.readFile(filePath, "utf-8");
            return { content: [{ type: "text", text: packet }] };
          } catch {
            return { content: [{ type: "text", text: "No fix packet found. Run rigour_check first on a failing state." }] };
          }
        }

        case "rigour_security_audit": {
          const audit = await runCommand(cwd, "npm", ["audit", "--json"]);
          const parsed = parseJsonOrNull<{ metadata?: { vulnerabilities?: Record<string, number> } }>(audit.stdout) || {};
          const vulnerabilities = parsed.metadata?.vulnerabilities || {};
          const advisoryCount = Object.values(vulnerabilities).reduce((sum, value) => sum + (Number(value) || 0), 0);
          return {
            content: [{
              type: "text",
              text: JSON.stringify({ source: "npm-audit", exitCode: audit.code, vulnerabilities, advisoryCount }, null, 2),
            }],
          };
        }

        case "rigour_hooks_init": {
          const cliArgs = ["hooks", "init"];
          const tool = getStringArg(args, "tool");
          if (tool) cliArgs.push("--tool", tool);
          if (getBooleanArg(args, "force")) cliArgs.push("--force");
          if (getBooleanArg(args, "dryRun")) cliArgs.push("--dry-run");
          const result = await runRigourCli(cwd, cliArgs);
          return {
            content: [{ type: "text", text: result.stdout || result.stderr || "hooks init executed" }],
            isError: result.code !== 0,
          };
        }

        case "rigour_hooks_check": {
          const files = getStringArrayArg(args, "files");
          const cliArgs = ["hooks", "check"];
          if (files.length > 0) cliArgs.push("--files", files.join(","));
          const result = await runRigourCli(cwd, cliArgs);
          return {
            content: [{ type: "text", text: result.stdout || result.stderr || "hooks check executed" }],
            isError: result.code !== 0,
          };
        }

        case "rigour_list_gates": {
          const cfg = await loadConfig(cwd);
          const cfgObj = cfg as unknown as { gates?: Record<string, unknown> };
          const gates = Object.keys(cfgObj.gates || {});
          return { content: [{ type: "text", text: JSON.stringify({ gateCount: gates.length, gates }, null, 2) }] };
        }

        case "rigour_get_config": {
          const cfg = await loadConfig(cwd);
          return { content: [{ type: "text", text: JSON.stringify(cfg, null, 2) }] };
        }

        case "rigour_check_pattern": {
          const pattern = (getStringArg(args, "name") || "").toLowerCase();
          const cfg = await loadConfig(cwd);
          const runner = new GateRunner(cfg);
          const report = await runner.run(cwd);
          const matches = report.failures.filter((f) => {
            const haystack = `${f.id} ${f.title} ${f.details} ${f.hint || ""}`.toLowerCase();
            return haystack.includes(pattern);
          });
          return { content: [{ type: "text", text: JSON.stringify({ pattern, found: matches.length > 0, matches }, null, 2) }] };
        }

        case "rigour_deep_stats": {
          const reportPath = path.join(cwd, "rigour-report.json");
          try {
            const reportRaw = await fs.readFile(reportPath, "utf-8");
            const report = parseJsonOrNull<{ stats?: JsonMap }>(reportRaw) || {};
            const stats = getObject(report.stats);
            return {
              content: [{
                type: "text",
                text: JSON.stringify(
                  {
                    score: stats.score,
                    ai_health_score: stats.ai_health_score,
                    code_quality_score: stats.code_quality_score,
                    deep: stats.deep,
                    updatedFrom: reportPath,
                  },
                  null,
                  2
                ),
              }],
            };
          } catch {
            return { content: [{ type: "text", text: "No rigour-report.json found. Run rigour_check_deep first." }] };
          }
        }

        case "rigour_record_failure": {
          const errorMessage = getStringArg(args, "errorMessage");
          if (!errorMessage) {
            return { content: [{ type: "text", text: "RIGOUR ERROR: errorMessage is required" }], isError: true };
          }
          const category = getStringArg(args, "category");
          await RetryLoopBreakerGate.recordFailure(cwd, errorMessage, category);
          return { content: [{ type: "text", text: `FAILURE RECORDED: ${category || "auto-classified"}\nError: ${errorMessage}` }] };
        }

        case "rigour_clear_failure": {
          const category = getStringArg(args, "category");
          if (!category) {
            return { content: [{ type: "text", text: "RIGOUR ERROR: category is required" }], isError: true };
          }
          await RetryLoopBreakerGate.clearFailure(cwd, category);
          return { content: [{ type: "text", text: `FAILURE CLEARED: ${category}` }] };
        }

        case "rigour_remember": {
          const key = getStringArg(args, "key");
          const value = getStringArg(args, "value");
          if (!key || !value) {
            return { content: [{ type: "text", text: "RIGOUR ERROR: key and value are required" }], isError: true };
          }
          const store = await loadMemory(cwd);
          store.memories[key] = { value, timestamp: new Date().toISOString() };
          await saveMemory(cwd, store);
          return { content: [{ type: "text", text: `MEMORY STORED: "${key}"` }] };
        }

        case "rigour_recall": {
          const key = getStringArg(args, "key");
          const store = await loadMemory(cwd);
          if (key) {
            const memory = store.memories[key];
            if (!memory) {
              return { content: [{ type: "text", text: `NO MEMORY FOUND for key "${key}".` }] };
            }
            return { content: [{ type: "text", text: `RECALLED MEMORY [${key}]:\n${memory.value}\n\n(Stored: ${memory.timestamp})` }] };
          }
          const keys = Object.keys(store.memories);
          if (keys.length === 0) {
            return { content: [{ type: "text", text: "NO MEMORIES STORED." }] };
          }
          const allMemories = keys
            .map((k) => {
              const mem = store.memories[k];
              return `## ${k}\n${mem.value}\n(Stored: ${mem.timestamp})`;
            })
            .join("\n\n---\n\n");
          return { content: [{ type: "text", text: `RECALLED ALL MEMORIES (${keys.length} items):\n\n${allMemories}` }] };
        }

        case "rigour_forget": {
          const key = getStringArg(args, "key");
          if (!key) {
            return { content: [{ type: "text", text: "RIGOUR ERROR: key is required" }], isError: true };
          }
          const store = await loadMemory(cwd);
          if (!store.memories[key]) {
            return { content: [{ type: "text", text: `NO MEMORY FOUND for key "${key}".` }] };
          }
          delete store.memories[key];
          await saveMemory(cwd, store);
          return { content: [{ type: "text", text: `MEMORY DELETED: "${key}"` }] };
        }

        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      await logStudioEvent(cwd, {
        type: "tool_response",
        requestId,
        tool: name,
        status: "error",
        content: [{ type: "text", text: `RIGOUR ERROR: ${message}` }],
      });
      return {
        content: [{ type: "text", text: `RIGOUR ERROR: ${message}` }],
        isError: true,
      };
    }
  });

  return server;
}
