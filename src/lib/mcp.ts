import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { GateRunner, ConfigSchema, RetryLoopBreakerGate } from "@rigour-labs/core";
import fs from "node:fs/promises";
import path from "node:path";
import yaml from "yaml";

async function loadConfig(cwd: string) {
    const configPath = path.join(cwd, "rigour.yml");
    try {
        await fs.access(configPath);
    } catch {
        throw new Error(`Rigour configuration (rigour.yml) not found at ${configPath}. 
NOTE: This MCP server is running REMOTELY and cannot see your local filesystem. 
If you are running this locally, ensure 'rigour init' has been run. 
If you are using the remote Vercel instance, it will only work for projects it has native access to or via CLI mode.`);
    }
    const configContent = await fs.readFile(configPath, "utf-8");
    return ConfigSchema.parse(yaml.parse(configContent));
}

// Memory persistence for context retention
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
        return JSON.parse(content);
    } catch {
        return { memories: {} };
    }
}

async function saveMemory(cwd: string, store: MemoryStore): Promise<void> {
    const memPath = await getMemoryPath(cwd);
    await fs.writeFile(memPath, JSON.stringify(store, null, 2));
}

export function createMcpServer() {
    const server = new Server(
        {
            name: "rigour-remote-mcp",
            version: "1.0.0",
        },
        {
            capabilities: {
                tools: {},
            },
        }
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => {
        return {
            tools: [
                {
                    name: "rigour_check",
                    description: "Run quality gate checks on the project. Matches the CLI 'check' command.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            cwd: {
                                type: "string",
                                description: "Absolute path to the project root.",
                            },
                        },
                        required: ["cwd"],
                    },
                },
                {
                    name: "rigour_explain",
                    description: "Explain the last quality gate failures with actionable bullets. Matches the CLI 'explain' command.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            cwd: {
                                type: "string",
                                description: "Absolute path to the project root.",
                            },
                        },
                        required: ["cwd"],
                    },
                },
                {
                    name: "rigour_status",
                    description: "Quick PASS/FAIL check with JSON-friendly output for polling current project state.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            cwd: {
                                type: "string",
                                description: "Absolute path to the project root.",
                            },
                        },
                        required: ["cwd"],
                    },
                },
                {
                    name: "rigour_get_fix_packet",
                    description: "Retrieves a prioritized 'Fix Packet' (v2 schema) containing detailed machine-readable diagnostic data.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            cwd: {
                                type: "string",
                                description: "Absolute path to the project root.",
                            },
                        },
                        required: ["cwd"],
                    },
                },
                {
                    name: "rigour_record_failure",
                    description: "Record an operation failure to track retry loops and prompt for documentation consult.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            cwd: {
                                type: "string",
                                description: "Absolute path to the project root.",
                            },
                            errorMessage: {
                                type: "string",
                                description: "The error message or type (e.g., 'Deployment failed').",
                            },
                            category: {
                                type: "string",
                                description: "Optional category (deployment, runtime_error, network, etc.). Auto-classified if omitted.",
                            },
                        },
                        required: ["cwd", "errorMessage"],
                    },
                },
                {
                    name: "rigour_clear_failure",
                    description: "Clear failure history for a category after a successful operation or manual fix.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            cwd: {
                                type: "string",
                                description: "Absolute path to the project root.",
                            },
                            category: {
                                type: "string",
                                description: "The failure category to clear (e.g., 'deployment').",
                            },
                        },
                        required: ["cwd", "category"],
                    },
                },
                {
                    name: "rigour_remember",
                    description: "Store a persistent instruction or context that the AI should remember across sessions. Use this to persist user preferences, project conventions, or critical instructions that the agent should always follow.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            cwd: {
                                type: "string",
                                description: "Absolute path to the project root.",
                            },
                            key: {
                                type: "string",
                                description: "A unique key for this memory (e.g., 'user_preferences', 'coding_style', 'critical_instructions').",
                            },
                            value: {
                                type: "string",
                                description: "The instruction or context to remember.",
                            },
                        },
                        required: ["cwd", "key", "value"],
                    },
                },
                {
                    name: "rigour_recall",
                    description: "Retrieve stored instructions or context. Call this at the start of each session to restore memory. Returns all stored memories if no key specified.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            cwd: {
                                type: "string",
                                description: "Absolute path to the project root.",
                            },
                            key: {
                                type: "string",
                                description: "Optional. Key of specific memory to retrieve. If omitted, returns all memories.",
                            },
                        },
                        required: ["cwd"],
                    },
                },
                {
                    name: "rigour_forget",
                    description: "Remove a stored memory by key.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            cwd: {
                                type: "string",
                                description: "Absolute path to the project root.",
                            },
                            key: {
                                type: "string",
                                description: "Key of the memory to remove.",
                            },
                        },
                        required: ["cwd", "key"],
                    },
                },
            ],
        };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;
        const cwd = (args as any)?.cwd || process.cwd();

        console.log(`[MCP] Tool Call: ${name}`, { args, cwd });

        try {
            const config = await loadConfig(cwd);
            const runner = new GateRunner(config);

            switch (name) {
                case "rigour_check": {
                    const report = await runner.run(cwd);
                    console.log(`[MCP] rigour_check result: ${report.status}`);
                    return {
                        content: [
                            {
                                type: "text",
                                text: `RIGOUR AUDIT RESULT: ${report.status}\n\nSummary:\n${Object.entries(report.summary).map(([k, v]) => `- ${k}: ${v}`).join("\n")}`,
                            },
                        ],
                    };
                }

                case "rigour_explain": {
                    const report = await runner.run(cwd);
                    if (report.status === "PASS") {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: "ALL QUALITY GATES PASSED. No failures to explain.",
                                },
                            ],
                        };
                    }

                    const bullets = report.failures.map((f, i) => {
                        return `${i + 1}. [${f.id.toUpperCase()}] ${f.title}: ${f.details}${f.hint ? ` (Hint: ${f.hint})` : ''}`;
                    }).join("\n");

                    return {
                        content: [
                            {
                                type: "text",
                                text: `RIGOUR EXPLAIN:\n\n${bullets}`,
                            },
                        ],
                    };
                }

                case "rigour_status": {
                    const report = await runner.run(cwd);
                    return {
                        content: [
                            {
                                type: "text",
                                text: JSON.stringify({
                                    status: report.status,
                                    summary: report.summary,
                                    failureCount: report.failures.length,
                                    durationMs: report.stats.duration_ms
                                }, null, 2),
                            },
                        ],
                    };
                }

                case "rigour_get_fix_packet": {
                    const report = await runner.run(cwd);
                    if (report.status === "PASS") {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: "ALL QUALITY GATES PASSED. The current state meets the required engineering standards.",
                                },
                            ],
                        };
                    }

                    const packet = report.failures.map((f, i) => {
                        let text = `FIX TASK ${i + 1}: [${f.id.toUpperCase()}] ${f.title}\n`;
                        text += `   - CONTEXT: ${f.details}\n`;
                        if (f.files && f.files.length > 0) {
                            text += `   - TARGET FILES: ${f.files.join(", ")}\n`;
                        }
                        if (f.hint) {
                            text += `   - REFACTORING GUIDANCE: ${f.hint}\n`;
                        }
                        return text;
                    }).join("\n---\n");

                    return {
                        content: [
                            {
                                type: "text",
                                text: `ENGINEERING REFINEMENT REQUIRED:\n\nThe project state violated ${report.failures.length} quality gates. You MUST address these failures before declaring the task complete:\n\n${packet}`,
                            },
                        ],
                    };
                }

                case "rigour_record_failure": {
                    const { errorMessage, category } = args as any;
                    await RetryLoopBreakerGate.recordFailure(cwd, errorMessage, category);
                    return {
                        content: [
                            {
                                type: "text",
                                text: `FAILURE RECORDED: ${category || 'auto-classified'}\nError: ${errorMessage}`,
                            },
                        ],
                    };
                }

                case "rigour_clear_failure": {
                    const { category } = args as any;
                    await RetryLoopBreakerGate.clearFailure(cwd, category);
                    return {
                        content: [
                            {
                                type: "text",
                                text: `FAILURE CLEARED: ${category}`,
                            },
                        ],
                    };
                }

                case "rigour_remember": {
                    const { key, value } = args as any;
                    const store = await loadMemory(cwd);
                    store.memories[key] = {
                        value,
                        timestamp: new Date().toISOString(),
                    };
                    await saveMemory(cwd, store);
                    console.log(`[MCP] Memory stored: ${key}`);
                    return {
                        content: [
                            {
                                type: "text",
                                text: `MEMORY STORED: "${key}" has been saved. This instruction will persist across sessions.\n\nStored value: ${value}`,
                            },
                        ],
                    };
                }

                case "rigour_recall": {
                    const { key } = args as any;
                    const store = await loadMemory(cwd);

                    if (key) {
                        // Retrieve specific memory
                        const memory = store.memories[key];
                        if (!memory) {
                            return {
                                content: [
                                    {
                                        type: "text",
                                        text: `NO MEMORY FOUND for key "${key}". Use rigour_remember to store instructions.`,
                                    },
                                ],
                            };
                        }
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `RECALLED MEMORY [${key}]:\n${memory.value}\n\n(Stored: ${memory.timestamp})`,
                                },
                            ],
                        };
                    }

                    // Retrieve all memories
                    const keys = Object.keys(store.memories);
                    if (keys.length === 0) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: "NO MEMORIES STORED. Use rigour_remember to persist important instructions.",
                                },
                            ],
                        };
                    }

                    const allMemories = keys.map(k => {
                        const mem = store.memories[k];
                        return `## ${k}\n${mem.value}\n(Stored: ${mem.timestamp})`;
                    }).join("\n\n---\n\n");

                    return {
                        content: [
                            {
                                type: "text",
                                text: `RECALLED ALL MEMORIES (${keys.length} items):\n\n${allMemories}\n\n---\nIMPORTANT: Follow these stored instructions throughout this session.`,
                            },
                        ],
                    };
                }

                case "rigour_forget": {
                    const { key } = args as any;
                    const store = await loadMemory(cwd);

                    if (!store.memories[key]) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `NO MEMORY FOUND for key "${key}". Nothing to forget.`,
                                },
                            ],
                        };
                    }

                    delete store.memories[key];
                    await saveMemory(cwd, store);

                    return {
                        content: [
                            {
                                type: "text",
                                text: `MEMORY DELETED: "${key}" has been removed.`,
                            },
                        ],
                    };
                }

                default:
                    throw new Error(`Unknown tool: ${name}`);
            }
        } catch (error: any) {
            console.error(`[MCP] Error in tool ${name}:`, error.message);
            return {
                content: [
                    {
                        type: "text",
                        text: `RIGOUR ERROR: ${error.message}`,
                    },
                ],
                isError: true,
            };
        }
    });

    console.log("[MCP] Server handlers initialized");
    return server;
}
