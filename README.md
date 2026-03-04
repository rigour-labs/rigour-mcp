# Rigour Remote MCP Server

A specialized Model Context Protocol (MCP) server built with **Next.js** for high-reliability deployment on Vercel. This server bridges local project states with remote AI agents, ensuring they follow your organization's quality gates.

## Core Features

- **SSE Transport**: Native Server-Sent Events support for real-time tool execution.
- **Zero-Telemetry**: No external data leaves your environment.
- **Stateless/Remote**: Designed to run as a secure bridge for remote agents.

## API Endpoints

- `GET /api/mcp/sse?sessionId=<ID>`: Establishes a long-lived SSE connection.
- `POST /api/mcp/messages?sessionId=<ID>`: Endpoint for JSON-RPC messages.
- `GET /api/health`: Service health check.

## Environment Variables

- `RIGOUR_MCP_TOKEN`: Optional Bearer token for authentication.

## Local Development

```bash
npm install
npm run dev
```

## Deployment

Pushed to main, automatically deployed to Vercel via GitHub integration.

## Azure Deployment (Container Apps)

Use the deployment script with shared Rigour infra defaults:

- Resource Group: `rigour-rg`
- ACR: `rigourrg`

```bash
# from rigour-mcp repo root
./scripts/deploy-azure.sh
```

Optional overrides:

```bash
./scripts/deploy-azure.sh --app rigour-mcp --rg rigour-rg --location eastus --acr rigourrg
```

Optional MCP token secret:

```bash
export RIGOUR_MCP_TOKEN="$(openssl rand -hex 32)"
./scripts/deploy-azure.sh
```
