import { NextRequest } from "next/server";
import { transports } from "../sse/route";
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
        return new Response("Session not found", { status: 404 });
    }

    try {
        const body = await request.json();
        await transport.handlePostMessage(request as any, body);
        return new Response("OK", { status: 200 });
    } catch (error: any) {
        console.error("Error handling MCP message:", error);
        return new Response(error.message, { status: 500 });
    }
}
