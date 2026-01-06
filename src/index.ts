import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Hono } from "hono";
import { handle } from "hono/vercel";
import { StreamableHTTPTransport } from "@hono/mcp";
import { GateRunner, ConfigSchema } from "@rigour-labs/core";
import fs from "node:fs/promises";
import path from "node:path";
import yaml from "yaml";

const app = new Hono();

// Optional Bearer token authentication
const RIGOUR_MCP_TOKEN = process.env.RIGOUR_MCP_TOKEN;

// Auth middleware
app.use("*", async (c, next) => {
    if (RIGOUR_MCP_TOKEN) {
        const authHeader = c.req.header("Authorization");
        if (!authHeader || !authHeader.startsWith("Bearer ")) {
            return c.json({ error: "Unauthorized: Missing Bearer token" }, 401);
        }
        const token = authHeader.substring(7);
        if (token !== RIGOUR_MCP_TOKEN) {
            return c.json({ error: "Unauthorized: Invalid token" }, 401);
        }
    }
    await next();
});

async function loadConfig(cwd: string) {
    const configPath = path.join(cwd, "rigour.yml");
    try {
        await fs.access(configPath);
    } catch {
        throw new Error("Rigour configuration (rigour.yml) not found. The agent must run `rigour init` first to establish engineering standards.");
    }
    const configContent = await fs.readFile(configPath, "utf-8");
    return ConfigSchema.parse(yaml.parse(configContent));
}

// Create MCP server instance
function createMcpServer() {
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
                    name: "rigour_list_gates",
                    description: "Lists all configured quality gates and their thresholds for the current project.",
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
                    name: "rigour_get_config",
                    description: "Returns the current Rigour configuration (rigour.yml) for agent reasoning.",
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
            ],
        };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;
        const cwd = (args as any)?.cwd || process.cwd();

        try {
            const config = await loadConfig(cwd);
            const runner = new GateRunner(config);

            switch (name) {
                case "rigour_check": {
                    const report = await runner.run(cwd);
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

                case "rigour_list_gates":
                    return {
                        content: [
                            {
                                type: "text",
                                text: `ACTIVE QUALITY GATES:\n\n${Object.entries(config.gates).map(([k, v]) => {
                                    if (typeof v === 'object' && v !== null) {
                                        return `- ${k}: ${JSON.stringify(v)}`;
                                    }
                                    return `- ${k}: ${v}`;
                                }).join("\n")}`,
                            },
                        ],
                    };

                case "rigour_get_config":
                    return {
                        content: [
                            {
                                type: "text",
                                text: JSON.stringify(config, null, 2),
                            },
                        ],
                    };

                default:
                    throw new Error(`Unknown tool: ${name}`);
            }
        } catch (error: any) {
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

    return server;
}

// MCP endpoint using @hono/mcp transport on root
app.all("/", async (c) => {
    const server = createMcpServer();
    const transport = new StreamableHTTPTransport();
    await server.connect(transport);

    // Handle the request and return the response
    const response = await transport.handleRequest(c);
    return response || c.json({ error: "No response from transport" }, 500);
});

// Health check endpoint
app.get("/health", (c) => {
    return c.json({
        status: "ok",
        service: "rigour-remote-mcp",
        version: "1.0.0",
        auth: RIGOUR_MCP_TOKEN ? "enabled" : "disabled"
    });
});

export default handle(app);
