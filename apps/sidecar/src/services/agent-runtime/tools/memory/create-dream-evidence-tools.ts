import type { ToolDefinition } from "@lume/agent-sdk";
import { readDreamEvidence, searchDreamEvidence, type DreamEvidenceItem } from "../../../memory-v2/dream-evidence";
import { createSdkJsonResultTool } from "../sdk-tool-result";

const SOURCE_TYPES = ["user_message", "assistant_message", "tool_result", "run_summary"] as const;

export function createDreamEvidenceTools(input: {
  workspaceSlug: string;
  jobId: string;
}): ToolDefinition[] {
  return [
    createSdkJsonResultTool({
      name: "memory.evidence.search",
      description: "Search only the conversation, tool, and run evidence captured for this private Dream job.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          maxResults: { type: "number", minimum: 1, maximum: 20 },
          sourceTypes: { type: "array", items: { type: "string", enum: [...SOURCE_TYPES] } }
        },
        required: ["query"]
      },
      isReadOnly: true,
      isConcurrencySafe: true,
      async call(args) {
        return {
          results: searchDreamEvidence({
            workspaceSlug: input.workspaceSlug,
            jobId: input.jobId,
            query: String(args.query ?? ""),
            maxResults: typeof args.maxResults === "number" ? args.maxResults : undefined,
            sourceTypes: Array.isArray(args.sourceTypes)
              ? args.sourceTypes.filter((value): value is DreamEvidenceItem["sourceType"] => SOURCE_TYPES.includes(value as DreamEvidenceItem["sourceType"]))
              : undefined
          })
        };
      }
    }),
    createSdkJsonResultTool({
      name: "memory.evidence.read",
      description: "Read one exact evidence item returned by memory.evidence.search. Arbitrary paths are not accepted.",
      inputSchema: {
        type: "object",
        properties: { evidenceId: { type: "string", minLength: 1 } },
        required: ["evidenceId"]
      },
      isReadOnly: true,
      isConcurrencySafe: true,
      async call(args) {
        const evidence = readDreamEvidence({
          workspaceSlug: input.workspaceSlug,
          jobId: input.jobId,
          evidenceId: String(args.evidenceId ?? "")
        });
        if (!evidence) throw new Error("Dream evidence not found or outside this job window");
        return evidence;
      }
    })
  ];
}
