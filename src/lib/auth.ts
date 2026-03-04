import { NextRequest } from "next/server";

const RIGOUR_MCP_TOKEN = process.env.RIGOUR_MCP_TOKEN;
const NODE_ENV = process.env.NODE_ENV || "development";

export function isAuthorized(request: NextRequest): boolean {
    if (!RIGOUR_MCP_TOKEN) {
        return NODE_ENV !== "production";
    }

    // 1. Check Header
    const authHeader = request.headers.get("Authorization");
    if (authHeader && authHeader.startsWith("Bearer ")) {
        const token = authHeader.substring(7);
        if (token === RIGOUR_MCP_TOKEN) return true;
    }

    // 2. Check Query Param (for EventSource friendliness)
    const { searchParams } = new URL(request.url);
    const queryToken = searchParams.get("token");
    if (queryToken === RIGOUR_MCP_TOKEN) return true;

    return false;
}
