export async function GET() {
    return Response.json({
        status: "ok",
        service: "rigour-remote-mcp",
        version: "1.0.0",
        platform: "nextjs"
    });
}
