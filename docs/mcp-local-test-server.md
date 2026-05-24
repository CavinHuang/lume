# Local MCP Test Server

Lume includes a local MCP test server for validating all supported transports during development.

## Import config

Print an importable `mcpServers` JSON payload:

```bash
bun run mcp:test:config
```

Paste the output into Settings > MCP > Import JSON.

The generated config contains:

- `lume-test-stdio`: spawns the test server with stdio.
- `lume-test-sse`: connects to the legacy SSE endpoint.
- `lume-test-http`: connects to the Streamable HTTP endpoint.

## Run remote transports

Start the local HTTP server for Streamable HTTP:

```bash
bun run mcp:test:http
```

Start the local HTTP server for legacy SSE:

```bash
bun run mcp:test:sse
```

Both commands listen on `127.0.0.1:39231` by default. Override with:

```bash
LUME_MCP_TEST_PORT=39232 bun run mcp:test:http
```

## Tools and resources

The server exposes:

- `echo`: repeats a message and includes the active transport in the result.
- `get_server_info`: returns metadata for the test server.
- `lume-test://server/info`: resource for list/read resource checks.
