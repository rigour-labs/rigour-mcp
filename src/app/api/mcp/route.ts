import { createMcpServer } from "@/lib/mcp";
import { NextRequest } from "next/server";
import { isAuthorized } from "@/lib/auth";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

export const dynamic = "force-dynamic";

const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id",
};

export async function POST(request: NextRequest) {
    if (!isAuthorized(request)) {
        return new Response("Unauthorized", { status: 401, headers: CORS_HEADERS });
    }

    const mcpServer = createMcpServer();
    const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // Stateless mode - no session tracking needed
        enableJsonResponse: true, // Return JSON responses instead of SSE
    });

    try {
        await mcpServer.connect(transport);

        // Handle the request using the native Request object
        const response = await transport.handleRequest(request as unknown as Request);

        // Inject CORS headers into the transport response
        const headers = new Headers(response.headers);
        for (const [key, value] of Object.entries(CORS_HEADERS)) {
            headers.set(key, value);
        }

        return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers,
        });
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "Internal server error";
        console.error("[MCP] Error handling request:", error);
        return Response.json({
            jsonrpc: "2.0",
            error: {
                code: -32603,
                message
            },
            id: null
        }, { status: 500, headers: CORS_HEADERS });
    } finally {
        await transport.close();
        await mcpServer.close();
    }
}

export async function GET(request: NextRequest) {
    if (!isAuthorized(request)) {
        return new Response("Unauthorized", { status: 401, headers: CORS_HEADERS });
    }

    // Stateless mode doesn't support GET for SSE streams
    return Response.json({
        jsonrpc: "2.0",
        error: {
            code: -32000,
            message: "This MCP server runs in stateless mode. Use POST requests only."
        },
        id: null
    }, { status: 405, headers: CORS_HEADERS });
}

export async function DELETE() {
    // Stateless mode doesn't have sessions to delete
    return Response.json({
        jsonrpc: "2.0",
        error: {
            code: -32000,
            message: "This MCP server runs in stateless mode. No sessions to delete."
        },
        id: null
    }, { status: 405, headers: CORS_HEADERS });
}

export async function OPTIONS() {
    return new Response(null, {
        status: 204,
        headers: CORS_HEADERS,
    });
}
