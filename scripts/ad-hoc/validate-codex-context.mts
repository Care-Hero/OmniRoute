// Temporary loopback harness for the real chatCore and Codex executor. The
// remote relay injects OAuth credentials; no upstream credential is held here.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

if (!process.env.CODEX_VALIDATION_RELAY_URL) throw new Error("Set CODEX_VALIDATION_RELAY_URL");
const relay = new URL(process.env.CODEX_VALIDATION_RELAY_URL);
if (relay.hostname !== "127.0.0.1") throw new Error("Relay must be an SSH loopback tunnel");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omni-source-live-"));
process.env.DATA_DIR = dataDir;
process.env.APP_LOG_TO_FILE = "false";
process.env.CODEX_CONTEXT_CHECK_MODE = "upstream";
process.env.CODEX_CLIENT_VERSION = "0.153.2";
const core = await import("../../src/lib/db/core.ts");
const compression = await import("../../src/lib/db/compression.ts");
const { handleChatCore } = await import("../../open-sse/handlers/chatCore.ts");
await compression.updateCompressionSettings({ enabled: false, defaultMode: "off" });

const fetchOriginal = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  if (!String(url).startsWith("https://chatgpt.com/backend-api/codex/responses")) {
    throw new Error("Unexpected validation upstream");
  }
  return fetchOriginal(relay, { ...options, headers: { "content-type": "application/json" } });
};

const log = { info() {}, debug() {}, warn() {}, error() {} };
const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url || "/", "http://127.0.0.1").pathname;
  if (req.method !== "POST" || pathname !== "/v1/messages") {
    res.writeHead(404);
    res.end();
    return;
  }
  const abort = new AbortController();
  res.on("close", () => abort.abort());
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 16 * 1024 * 1024) throw new Error("Body too large");
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!["cx/gpt-5.6-sol", "gpt-5.6-sol"].includes(body.model))
      throw new Error("Unexpected model");
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (typeof value === "string") headers.set(name, value);
    }
    const result = await handleChatCore({
      body,
      modelInfo: { provider: "codex", model: "gpt-5.6-sol" },
      credentials: { accessToken: "validation-relay-only", providerSpecificData: {} },
      clientRawRequest: { endpoint: "/v1/messages", body, headers },
      userAgent: headers.get("user-agent") || "claude-cli/2.1.263",
      signal: abort.signal,
      log,
    });
    const response = result.response;
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) {
      Readable.fromWeb(response.body)
        .on("error", () => res.destroy())
        .pipe(res);
    } else res.end();
    console.log(
      JSON.stringify({ requestBytes: size, stream: body.stream, status: response.status })
    );
  } catch (error) {
    if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "validation handler failed" } }));
    console.error(error instanceof Error ? error.name : "UnknownError");
  }
});
server.listen(20139, "127.0.0.1", () => console.log("LOCAL_SOURCE_READY"));
function stop() {
  server.closeAllConnections();
  server.close();
  core.resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true });
  process.exit(0);
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
