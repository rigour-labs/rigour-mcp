import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { createMcpServer } from "@/lib/mcp";
import { NextRequest } from "next/server";

// Store active transports to send messages back
export const transports = new Map<string, SSEServerTransport>();

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
    const { searchParams } = new URL(request.url);
    const sessionId = searchParams.get("sessionId");

    if (!sessionId) {
        return new Response("Missing sessionId", { status: 400 });
    }

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
        "/api/mcp/messages",
        mockRes as any
    );

    transports.set(sessionId, transport);

    const mcpServer = createMcpServer();
    await mcpServer.connect(transport);

    return new Response(responseStream.readable, {
        headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
        },
    });
}
