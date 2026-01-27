import { NextRequest } from "next/server";
import { transports } from "@/lib/state";
import { isAuthorized } from "@/lib/auth";

export async function POST(request: NextRequest) {
    if (!isAuthorized(request)) {
        return new Response("Unauthorized", { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const sessionId = searchParams.get("sessionId");

    if (!sessionId) {
        return new Response("Missing sessionId", { status: 400 });
    }

    const transport = transports.get(sessionId);
    if (!transport) {
        console.warn(`[MCP] Session not found: ${sessionId}. Active sessions: ${Array.from(transports.keys()).join(", ")}`);
        return new Response("Session not found (Server might have restarted or session expired)", { status: 404 });
    }

    try {
        const body = await request.json();
        await transport.handlePostMessage(request as any, body);
        return new Response("OK", {
            status: 200,
            headers: {
                "Access-Control-Allow-Origin": "*",
            },
        });
    } catch (error: any) {
        console.error("Error handling MCP message:", error);
        return new Response(error.message, {
            status: 500,
            headers: {
                "Access-Control-Allow-Origin": "*",
            },
        });
    }
}

export async function OPTIONS() {
    return new Response(null, {
        status: 204,
        headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
    });
}
