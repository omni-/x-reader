import { Reader } from "../dist/reader.js";
import { createMcpServer } from "../dist/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { FixtureBrowser } from "./fixtures.mjs";
import { videoRoutes } from "./video-fixtures.mjs";
const reader = new Reader(new FixtureBrowser({ onPage: videoRoutes }));
const server = createMcpServer(reader);
await server.connect(new StdioServerTransport());
process.once("SIGTERM", async () => {
  await server.close();
  await reader.close();
});
