# Rigour MCP - Remote Server

Deploy Rigour's quality gates over HTTP for web-based AI agents.

## 🚀 Quick Deploy to Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/rigour-labs/rigour-mcp)

1. Click the button above
2. (Optional) Add `RIGOUR_MCP_TOKEN` environment variable for authentication
3. Deploy!

Your Rigour MCP server will be live at `https://your-project.vercel.app/mcp`

## 📦 What's This?

This is a standalone HTTP server that exposes [Rigour](https://github.com/rigour-labs/rigour)'s quality gates via the Model Context Protocol. Perfect for web-based AI agents that can't use stdio.

**Use this if:**
- You're building a web-based AI agent
- You need HTTP/REST access to Rigour
- You want to deploy to Vercel/Cloud Run/Fly.io

**Use [stdio MCP](https://github.com/rigour-labs/rigour/tree/main/packages/rigour-mcp) if:**
- You're using Cursor, Claude Desktop, or Cline
- You're running agents locally

## 🛠️ Local Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Start server
npm start

# Or dev mode with hot reload
npm run dev
```

Server runs on `http://localhost:3000` by default.

## 🔐 Authentication (Optional)

```bash
# Generate a secure token
openssl rand -hex 32

# Set environment variable
export RIGOUR_MCP_TOKEN="your-token-here"

# Start server
npm start
```

If `RIGOUR_MCP_TOKEN` is not set, the server runs in open mode (no auth required).

## 🌐 Deployment Options

### Vercel (Recommended)

```bash
npm i -g vercel
vercel
```

### Google Cloud Run

```bash
gcloud run deploy rigour-mcp \
  --source . \
  --platform managed \
  --region us-central1
```

### Fly.io

```bash
fly launch
fly deploy
```

### Railway

```bash
railway up
```

## 📡 API Endpoints

- `POST /mcp` - MCP JSON-RPC endpoint
- `GET /health` - Health check

## 🧪 Testing

```bash
# Health check
curl http://localhost:3000/health

# Call a tool
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-token" \
  -d '{
    "jsonrpc": "2.0",
    "method": "tools/call",
    "params": {
      "name": "rigour_status",
      "arguments": {
        "cwd": "/path/to/project"
      }
    },
    "id": 1
  }'
```

## 📚 Documentation

- [Full Documentation](https://docs.rigour.run/mcp/remote-mcp-server)
- [Rigour Core](https://github.com/rigour-labs/rigour)
- [MCP Specification](https://modelcontextprotocol.io)

## 🔧 Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `3000` | Server port |
| `RIGOUR_MCP_TOKEN` | No | - | Bearer token for authentication |

## 📄 License

MIT
