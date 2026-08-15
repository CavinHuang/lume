export interface CatalogTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const MAX_DESCRIPTION_LINES = 6;

/** Render the agent tool catalog as TypeScript-flavored SDK text for the REPL. */
export function renderToolCatalogSdk(tools: CatalogTool[]): string {
  const header =
    "Agent tools are callable from this REPL as `await tools.name(params)`; every call goes through the normal permission approval. Explicit form: `await tools.call(name, params)`; full catalog: `await tools.documentation()`.";
  const sections = tools.map((tool) => renderToolSection(tool));
  return [header, ...sections].join("\n\n");
}

export function buildToolCatalogResult(tools: CatalogTool[]): { tools: CatalogTool[]; documentation: string } {
  return { tools, documentation: renderToolCatalogSdk(tools) };
}

function renderToolSection(tool: CatalogTool): string {
  const description = truncateDescription(tool.description);
  const signature = renderSignature(tool.name, tool.inputSchema);
  return [`## ${tool.name}`, description, signature].filter(Boolean).join("\n");
}

function truncateDescription(description: string): string {
  const lines = description.split("\n");
  if (lines.length <= MAX_DESCRIPTION_LINES) return description;
  return lines.slice(0, MAX_DESCRIPTION_LINES).join("\n");
}

function renderSignature(name: string, inputSchema: Record<string, unknown>): string {
  const properties = readProperties(inputSchema);
  const entries = Object.entries(properties);
  if (entries.length === 0) return `await tools.${name}()`;
  const params = entries.map(([key, schema]) => `${key}: ${renderType(schema)}`).join(", ");
  return `await tools.${name}({ ${params} })`;
}

function readProperties(inputSchema: Record<string, unknown>): Record<string, unknown> {
  const properties = inputSchema.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return {};
  return properties as Record<string, unknown>;
}

function renderType(schema: unknown): string {
  const type = schema && typeof schema === "object" && !Array.isArray(schema)
    ? (schema as Record<string, unknown>).type
    : undefined;
  switch (type) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "array":
      return "unknown[]";
    case "object":
      return "Record<string, unknown>";
    default:
      return "unknown";
  }
}
