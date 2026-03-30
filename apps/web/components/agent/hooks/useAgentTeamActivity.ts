import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentMessage } from "@lume/shared";
import type { ToolActivity } from "@/atoms/agent-atoms";
import { listSubagentRuns } from "@/lib/desktop-api/agent";
import {
  buildTeamActivitiesFromRuns,
  buildTeamActivitiesFromSession,
  extractTeamInboxFromMessages,
  extractTeamOverview,
  mergeToolActivities,
  type TeamAgentInfo
} from "../team-activity";
import {
  findLatestTodoItems,
  resolveTodoPanelExpanded,
  type TodoItem
} from "../agent-team-activity";

export function useAgentTeamActivity(
  sessionId: string | null,
  messages: AgentMessage[],
  toolActivities: ToolActivity[]
): {
  latestTodoItems: TodoItem[] | null;
  todoPanelExpanded: boolean;
  setTodoPanelExpanded: React.Dispatch<React.SetStateAction<boolean>>;
  todoProgressText: string | null;
  teamInboxItems: ReturnType<typeof extractTeamInboxFromMessages>;
  teamActivities: ReturnType<typeof mergeToolActivities>;
  runningTeamAgents: TeamAgentInfo[];
} {
  const [todoPanelExpanded, setTodoPanelExpanded] = useState(true);
  const prevTodoItemsRef = useRef<TodoItem[] | null>(null);
  const [teamRunActivities, setTeamRunActivities] = useState<ReturnType<typeof buildTeamActivitiesFromSession>>([]);

  const latestTodoItems = useMemo(
    () => findLatestTodoItems(toolActivities, messages),
    [messages, toolActivities]
  );

  const teamActivitiesFromSession = useMemo(
    () => buildTeamActivitiesFromSession(messages, toolActivities),
    [messages, toolActivities]
  );
  const teamInboxItems = useMemo(
    () => extractTeamInboxFromMessages(messages),
    [messages]
  );
  const teamActivities = useMemo(
    () => mergeToolActivities(teamActivitiesFromSession, teamRunActivities),
    [teamActivitiesFromSession, teamRunActivities]
  );
  const runningTeamAgents = useMemo(() => {
    const overview = extractTeamOverview(teamActivities);
    return (overview?.agents ?? []).filter(
      (a) => a.status === "running" || a.status === "backgrounded"
    );
  }, [teamActivities]);

  const todoProgressText = useMemo(() => {
    if (!latestTodoItems || latestTodoItems.length === 0) return null;
    const completed = latestTodoItems.filter((todo) => todo.status === "completed").length;
    return `${completed}/${latestTodoItems.length}`;
  }, [latestTodoItems]);

  useEffect(() => {
    if (!sessionId) {
      setTeamRunActivities([]);
      return;
    }

    let disposed = false;
    const pollRuns = async (): Promise<void> => {
      try {
        const result = await listSubagentRuns({
          ownerSessionId: sessionId,
          limit: 200
        });
        if (disposed) return;
        setTeamRunActivities(buildTeamActivitiesFromRuns(result.runs));
      } catch (error) {
        if (!disposed) {
          console.warn("[AgentView] 查询 subagent runs 失败:", error);
        }
      }
    };

    void pollRuns();
    const timer = setInterval(() => {
      void pollRuns();
    }, 2500);

    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [sessionId]);

  useEffect(() => {
    if (!latestTodoItems || latestTodoItems.length === 0) return;
    const nextExpanded = resolveTodoPanelExpanded(prevTodoItemsRef.current, latestTodoItems);
    if (typeof nextExpanded === "boolean") {
      setTodoPanelExpanded(nextExpanded);
    }
    prevTodoItemsRef.current = latestTodoItems;
  }, [latestTodoItems]);

  return {
    latestTodoItems,
    todoPanelExpanded,
    setTodoPanelExpanded,
    todoProgressText,
    teamInboxItems,
    teamActivities,
    runningTeamAgents
  };
}
