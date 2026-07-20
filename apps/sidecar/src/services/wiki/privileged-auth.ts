import { timingSafeEqual } from "node:crypto";

export class WikiPrivilegedCredentialGate {
  private credential: Buffer | undefined;

  install(value: unknown): void {
    if (this.credential) return;
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
      throw new Error("Wiki privileged credential 非法");
    }
    this.credential = Buffer.from(value, "utf8");
  }

  assert(value: unknown): void {
    if (!this.credential || typeof value !== "string") {
      throw new Error("WIKI_PRIVILEGED_UNAVAILABLE: Wiki 正式确认通道不可用");
    }
    const candidate = Buffer.from(value, "utf8");
    if (candidate.length !== this.credential.length || !timingSafeEqual(candidate, this.credential)) {
      throw new Error("WIKI_PRIVILEGED_DENIED: Wiki 正式确认凭证无效");
    }
  }

  ready(): boolean {
    return Boolean(this.credential);
  }
}

const gate = new WikiPrivilegedCredentialGate();

export function installWikiPrivilegedCredential(value: unknown): void {
  gate.install(value);
}

export function assertWikiPrivilegedCredential(value: unknown): void {
  gate.assert(value);
}

export function wikiPrivilegedCredentialReady(): boolean {
  return gate.ready();
}
