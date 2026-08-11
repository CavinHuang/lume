import { useEffect, useRef, useState } from "react";
import type { LinkAuthorizationSignal } from "@lume/shared";
import { useSetAtom } from "jotai";
import { activeTabIdAtom, linkProviderTargetAtom, tabsAtom } from "@/atoms";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { agentSend, listLinkConnections, onLinkDataChanged } from "@/lib/desktop-api";
import { ProviderIcon } from "@/components/link/ProviderIcon";
import { toast } from "sonner";

export function LinkResult({
  toolName,
  input,
  result,
  authorization,
}: {
  toolName: string;
  input: Record<string, unknown>;
  result: unknown;
  authorization?: LinkAuthorizationSignal;
}) {
  const setTabs = useSetAtom(tabsAtom);
  const setActiveTabId = useSetAtom(activeTabIdAtom);
  const setProviderTarget = useSetAtom(linkProviderTargetAtom);
  const [authorized, setAuthorized] = useState(false);
  const autoResentRef = useRef(false);
  // 追踪"具体被授权的 signal"，防止 A→B 信号切换时自动重发 effect 用旧 authorized 闭包误发未授权的 B
  const authorizedSignalRef = useRef<LinkAuthorizationSignal | null>(null);
  const signal = authorization ?? readAuthorization(result);
  const resultRecord = result && typeof result === "object" && !Array.isArray(result)
    ? result as Record<string, unknown>
    : null;
  useEffect(() => {
    if (!signal) return;
    setAuthorized(false);
    autoResentRef.current = false; // 新信号重置自动重发标记
    authorizedSignalRef.current = null; // 新信号清空已授权标记，强制重新走授权+匹配流程
    let active = true;
    const check = () =>
      void listLinkConnections()
        .then((connections) => {
          if (
            active &&
            connections.some(
              (item) =>
                item.service === signal.service &&
                item.configured &&
                item.connectionName === (signal.connectionName || "default"),
            )
          ) {
            setAuthorized(true);
            authorizedSignalRef.current = signal; // 记录"具体被授权的 signal"，供自动重发 effect 匹配
          }
        })
        .catch(() => undefined);
    check();
    let unsubscribe: (() => void) | undefined;
    void onLinkDataChanged(check).then((off) => { unsubscribe = off; });
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [signal]);
  useEffect(() => {
    // 额外要求当前 signal 就是被授权的那个（authorizedSignalRef），防止 A→B 信号切换时
    // 用渲染 N 的旧 authorized 闭包对未授权的 B 误发
    if (!authorized || !signal || autoResentRef.current || authorizedSignalRef.current !== signal) return;
    autoResentRef.current = true;
    void agentSend({
      threadId: signal.threadId,
      userMessage: buildRetryMessage(signal),
    }).catch((error) => toast.error(error instanceof Error ? error.message : "自动重试失败"));
  }, [authorized, signal]);
  const openProvider = () => {
    setProviderTarget(signal ? {
      service: signal.service,
      ...(signal.connectionName ? { connectionName: signal.connectionName } : {}),
    } : null);
    setTabs((tabs) =>
      tabs.some((tab) => tab.id === "__link__")
        ? tabs
        : [...tabs, { id: "__link__", type: "link", title: "连接器" }],
    );
    setActiveTabId("__link__");
  };
  if (signal)
    return (
      <div className="space-y-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
        <div className="font-medium flex items-center gap-2">
          <ProviderIcon service={signal.service} size={18} />
          需要连接 {signal.service}
        </div>
        <p className="text-xs text-muted-foreground">
          请在 Lume 中完成授权，再由 Agent 重试原操作。
        </p>
        <div className="flex gap-2">
          <Button size="sm" onClick={openProvider}>
            打开连接器
          </Button>
          {authorized && (
            <Button
              size="sm"
              variant="ghost"
              className="text-xs text-muted-foreground"
              onClick={() => {
                autoResentRef.current = true;
                void agentSend({
                  threadId: signal.threadId,
                  userMessage: buildRetryMessage(signal),
                }).catch((error) => toast.error(error instanceof Error ? error.message : "重试失败"));
              }}
            >
              再次发送
            </Button>
          )}
        </div>
      </div>
    );
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>{String(input.service || "OpenConnector")}</span>
        {typeof input.connectionName === "string" && input.connectionName && <span>账户：{input.connectionName}</span>}
        {typeof input.action === "string" && input.action && <span>动作：{input.action}</span>}
        {typeof resultRecord?.durationMs === "number" && <span>耗时：{resultRecord.durationMs}ms</span>}
        <span>状态：完成</span>
      </div>
      <Collapsible>
      <CollapsibleTrigger render={<Button variant="ghost" size="sm" />}>
        查看 {toolName} 结果
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre className="mt-2 max-h-72 overflow-auto rounded-md bg-muted p-3 text-xs">
          {typeof result === "string"
            ? result
            : JSON.stringify(result, null, 2)}
        </pre>
      </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
function readAuthorization(
  result: unknown,
): LinkAuthorizationSignal | undefined {
  const value =
    result && typeof result === "object"
      ? (result as Record<string, unknown>)
      : null;
  const auth = value?.authorization;
  return auth &&
    typeof auth === "object" &&
    (auth as { kind?: unknown }).kind === "link_authorization_required"
    ? (auth as LinkAuthorizationSignal)
    : undefined;
}

function buildRetryMessage(signal: LinkAuthorizationSignal): string {
  const connection = signal.connectionName ? `，连接 ${signal.connectionName}` : "";
  return `请重试刚才失败的 Link 操作（${signal.service}.${signal.actionId}${connection}）。这是重试请求，不是新的外部操作授权。`;
}
