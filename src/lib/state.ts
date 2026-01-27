import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

// Store active transports to send messages back
// In a persistent container (Railway), this global state is shared across all requests
export const transports = new Map<string, SSEServerTransport>();
