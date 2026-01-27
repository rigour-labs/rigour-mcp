import Image from "next/image";

export default function Home() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-zinc-50 font-sans dark:bg-black p-8">
      <main className="w-full max-w-2xl bg-white dark:bg-zinc-900 rounded-2xl shadow-xl border border-zinc-200 dark:border-zinc-800 p-8 md:p-12">
        <div className="flex items-center gap-3 mb-8">
          <div className="w-10 h-10 bg-indigo-600 rounded-lg flex items-center justify-center">
            <span className="text-white font-bold text-xl">R</span>
          </div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-white">Rigour Remote MCP</h1>
        </div>

        <section className="space-y-6">
          <div>
            <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100 mb-2">Setup Instructions</h2>
            <p className="text-zinc-600 dark:text-zinc-400">
              Connect this MCP server to Claude AI, Antigravity, or other MCP-compatible tools:
            </p>
          </div>

          <div className="bg-zinc-100 dark:bg-black rounded-xl p-4 font-mono text-sm break-all border border-zinc-200 dark:border-zinc-800 flex justify-between items-center group">
            <code id="mcp-url" className="text-indigo-600 dark:text-indigo-400">https://mcp.rigour.run/api/mcp</code>
          </div>

          <div className="space-y-4">
            <div className="flex gap-4">
              <div className="flex-shrink-0 w-6 h-6 rounded-full bg-zinc-200 dark:bg-zinc-800 text-xs flex items-center justify-center font-bold">1</div>
              <p className="text-zinc-600 dark:text-zinc-400 text-sm">
                Open your MCP client (e.g., Claude Desktop, Cursor, or Antigravity settings).
              </p>
            </div>
            <div className="flex gap-4">
              <div className="flex-shrink-0 w-6 h-6 rounded-full bg-zinc-200 dark:bg-zinc-800 text-xs flex items-center justify-center font-bold">2</div>
              <p className="text-zinc-600 dark:text-zinc-400 text-sm">
                Choose <span className="font-semibold text-zinc-900 dark:text-zinc-100">Streamable HTTP</span> as the transport type.
              </p>
            </div>
            <div className="flex gap-4">
              <div className="flex-shrink-0 w-6 h-6 rounded-full bg-zinc-200 dark:bg-zinc-800 text-xs flex items-center justify-center font-bold">3</div>
              <p className="text-zinc-600 dark:text-zinc-400 text-sm">
                Paste the URL above. This server runs in stateless mode for maximum reliability.
              </p>
            </div>
          </div>


          <div className="pt-6 border-t border-zinc-100 dark:border-zinc-800 flex justify-between items-center">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse"></div>
              <span className="text-xs font-medium text-zinc-500 uppercase tracking-wider">Service Active</span>
            </div>
            <a
              href="/api/health"
              className="text-xs text-indigo-500 hover:text-indigo-600 font-medium transition-colors"
            >
              Check Health →
            </a>
          </div>
        </section>
      </main>

      <footer className="mt-8 text-zinc-400 dark:text-zinc-600 text-xs">
        Powered by Rigour Labs • v1.0.0
      </footer>
    </div>
  );
}
