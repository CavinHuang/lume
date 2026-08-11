import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { LinkOAuthSession } from "@lume/shared";

type PersistedSession = LinkOAuthSession & { startedAt: number };

const FILE_NAME = "link-oauth-sessions.json";
const SESSION_TTL_MS = 5 * 60_000;

/**
 * OAuth pending session store that survives sidecar (UtilityProcess) restarts by
 * persisting to `${configDir}/link-oauth-sessions.json`. Falls back to in-memory
 * when configDir is unavailable (headless/missing LUME_CONFIG_DIR). Pending
 * sessions older than SESSION_TTL_MS are expired to "timed_out" on load.
 */
export class PersistentOAuthSessions {
  private readonly sessions = new Map<string, PersistedSession>();
  private readonly file?: string;

  constructor(configDir?: string) {
    this.file = configDir ? join(configDir, FILE_NAME) : undefined;
    this.load();
  }

  private load(): void {
    if (!this.file || !existsSync(this.file)) return;
    try {
      const entries = JSON.parse(readFileSync(this.file, "utf8")) as Array<[string, PersistedSession]>;
      const now = Date.now();
      for (const [state, session] of entries) {
        if (session && session.status === "pending" && now - session.startedAt > SESSION_TTL_MS) {
          session.status = "timed_out";
        }
        this.sessions.set(state, session);
      }
    } catch {
      // corrupt or unreadable → start empty
    }
  }

  private persist(): void {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify([...this.sessions.entries()]), { mode: 0o600 });
    renameSync(temporary, this.file);
  }

  get(state: string): PersistedSession | undefined {
    return this.sessions.get(state);
  }

  set(state: string, session: PersistedSession): void {
    this.sessions.set(state, session);
    this.persist();
  }

  delete(state: string): void {
    this.sessions.delete(state);
    this.persist();
  }

  values(): IterableIterator<PersistedSession> {
    return this.sessions.values();
  }

  flush(): void {
    this.persist();
  }
}
