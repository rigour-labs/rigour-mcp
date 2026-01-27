import { transports } from "@/lib/state";
import { POST as handleMessagePost } from "../messages/route";
import { createMcpServer } from "@/lib/mcp";
import { NextRequest } from "next/server";
import { isAuthorized } from "@/lib/auth";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
    if (!isAuthorized(request)) {
        return new Response("Unauthorized", { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    let sessionId = searchParams.get("sessionId");

    if (!sessionId) {
        sessionId = crypto.randomUUID();
    }

    request.signal.addEventListener("abort", () => {
        transports.delete(sessionId);
    });

    const responseStream = new TransformStream();
    const writer = responseStream.writable.getWriter();
    const encoder = new TextEncoder();

    // Satisfy the Node.js Writable interface roughly enough for the SDK
    const mockRes = {
        writeHead(status: number, headers: any) {
            // Next.js handles headers via Response object
        },
        write(chunk: any, callback?: any) {
            writer.write(encoder.encode(chunk));
            if (callback) callback();
            return true;
        },
        end() {
            writer.close();
            transports.delete(sessionId);
        },
        on(event: string, listener: any) {
            // No-op for now
            return this;
        }
    };

    const transport = new SSEServerTransport(
        `/api/mcp/messages?sessionId=${sessionId}`,
        mockRes as any
    );

    transports.set(sessionId, transport);

    const mcpServer = createMcpServer();
    await mcpServer.connect(transport);

    const headers = new Headers({
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Session-Id",
        "X-Accel-Buffering": "no", // Disable buffering for Vercel/Nginx
    });

    return new Response(responseStream.readable, { headers });
}

export async function POST(request: NextRequest) {
    console.log(`[MCP] POST fallback to SSE route for ${request.url}`);
    return handleMessagePost(request);
}

export async function OPTIONS() {
    return new Response(null, {
        status: 204,
        headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
    });
}
