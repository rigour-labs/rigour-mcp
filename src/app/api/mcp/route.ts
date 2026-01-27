import { createMcpServer } from "@/lib/mcp";
import { NextRequest } from "next/server";
import { isAuthorized } from "@/lib/auth";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
    if (!isAuthorized(request)) {
        return new Response("Unauthorized", { status: 401 });
    }

    try {
        // Create a new server and transport for each request (stateless mode)
        const mcpServer = createMcpServer();
        const transport = new WebStandardStreamableHTTPServerTransport({
            sessionIdGenerator: undefined, // Stateless mode - no session tracking needed
            enableJsonResponse: true, // Return JSON responses instead of SSE
        });

        await mcpServer.connect(transport);

        // Handle the request using the native Request object
        const response = await transport.handleRequest(request as unknown as Request);

        // Clean up after request
        request.signal.addEventListener("abort", async () => {
            await transport.close();
            await mcpServer.close();
        });

        return response;
    } catch (error: any) {
        console.error("[MCP] Error handling request:", error);
        return Response.json({
            jsonrpc: "2.0",
            error: {
                code: -32603,
                message: error.message || "Internal server error"
            },
            id: null
        }, { status: 500 });
    }
}

export async function GET(request: NextRequest) {
    if (!isAuthorized(request)) {
        return new Response("Unauthorized", { status: 401 });
    }

    // Stateless mode doesn't support GET for SSE streams
    return Response.json({
        jsonrpc: "2.0",
        error: {
            code: -32000,
            message: "This MCP server runs in stateless mode. Use POST requests only."
        },
        id: null
    }, { status: 405 });
}

export async function DELETE(request: NextRequest) {
    // Stateless mode doesn't have sessions to delete
    return Response.json({
        jsonrpc: "2.0",
        error: {
            code: -32000,
            message: "This MCP server runs in stateless mode. No sessions to delete."
        },
        id: null
    }, { status: 405 });
}

export async function OPTIONS() {
    return new Response(null, {
        status: 204,
        headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id",
        },
    });
}
