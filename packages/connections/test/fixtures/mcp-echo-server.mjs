// A minimal MCP server over stdio for the tests: two tools, one of them needs a secret from the environment.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "echo", version: "0.0.1" });
server.registerTool("echo", { description: "Echoes the text back", inputSchema: { text: z.string() } }, async ({ text }) => ({
  content: [{ type: "text", text: `echo: ${text}` }],
}));
server.registerTool("whoami", { description: "Says who the API key belongs to", inputSchema: {} }, async () => ({
  content: [{ type: "text", text: process.env.ECHO_API_KEY ? `key ${process.env.ECHO_API_KEY.slice(0, 4)}…` : "no key" }],
}));
await server.connect(new StdioServerTransport());
