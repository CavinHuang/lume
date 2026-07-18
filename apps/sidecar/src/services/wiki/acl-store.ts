import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type { WikiAccessGrant, WikiPageFrontmatter, WikiSearchScope, WikiTrustedSubject } from "@lume/shared";
import { ensureWikiDirectory, resolveWikiPath } from "./path-security";

export class WikiAclStore {
  constructor(readonly root: string) {}

  private path(): string {
    ensureWikiDirectory(this.root, ".lume");
    return resolveWikiPath(this.root, ".lume/acl-events.jsonl");
  }

  append(sourceId: string, workspaceId: string, action: "grant" | "revoke", actor: string): WikiAccessGrant {
    const event: WikiAccessGrant = { id: randomUUID(), sourceId, workspaceId, action, actor, createdAt: new Date().toISOString() };
    appendFileSync(this.path(), `${JSON.stringify(event)}\n`, "utf8");
    return event;
  }

  list(): WikiAccessGrant[] {
    const path = this.path();
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as WikiAccessGrant);
  }

  hasGrant(sourceId: string, workspaceId: string): boolean {
    const events = this.list().filter((event) => event.sourceId === sourceId && event.workspaceId === workspaceId);
    return events.at(-1)?.action === "grant";
  }

  revokeWorkspace(workspaceId: string, actor: string): void {
    const active = new Set(this.list().filter((event) => event.workspaceId === workspaceId && event.action === "grant").map((event) => event.sourceId));
    for (const sourceId of active) if (this.hasGrant(sourceId, workspaceId)) this.append(sourceId, workspaceId, "revoke", actor);
  }
}

export function pageAllowed(frontmatter: WikiPageFrontmatter, subject: WikiTrustedSubject, scope: WikiSearchScope): boolean {
  if (scope.kind === "all") return subject.allowAll;
  if (scope.kind === "inbox") return subject.allowInbox && frontmatter.primary_workspace_id === null;
  if (scope.kind === "page") {
    if (subject.kind === "desktop_owner") return true;
    if (frontmatter.primary_workspace_id === null) return subject.allowInbox;
    return [frontmatter.primary_workspace_id, ...frontmatter.associated_workspace_ids]
      .some((workspaceId) => subject.workspaceIds.includes(workspaceId));
  }
  const workspaceId = scope.kind === "workspace" ? scope.workspaceId : undefined;
  if (workspaceId && subject.kind === "desktop_owner") {
    return frontmatter.primary_workspace_id === workspaceId || frontmatter.associated_workspace_ids.includes(workspaceId);
  }
  if (!workspaceId || !subject.workspaceIds.includes(workspaceId)) return false;
  return frontmatter.primary_workspace_id === workspaceId || frontmatter.associated_workspace_ids.includes(workspaceId);
}

export function sourceAllowed(sourceId: string, page: WikiPageFrontmatter, subject: WikiTrustedSubject, scope: WikiSearchScope, acl: WikiAclStore): boolean {
  if (!pageAllowed(page, subject, scope)) return false;
  if (subject.kind === "desktop_owner") return true;
  if (scope.kind === "workspace") return acl.hasGrant(sourceId, scope.workspaceId);
  return [page.primary_workspace_id, ...page.associated_workspace_ids]
    .filter((workspaceId): workspaceId is string => Boolean(workspaceId && subject.workspaceIds.includes(workspaceId)))
    .some((workspaceId) => acl.hasGrant(sourceId, workspaceId));
}
