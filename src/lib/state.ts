import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

// Store active transports to send messages back
// Using a global to ensure persistence within the same lambda worker
const globalForMcp = global as unknown as {
    transports: Map<string, SSEServerTransport> | undefined
};

export const transports = globalForMcp.transports ?? new Map<string, SSEServerTransport>();

if (process.env.NODE_ENV !== 'production') {
    globalForMcp.transports = transports;
}
