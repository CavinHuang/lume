import { timingSafeEqual } from "node:crypto";

export class PrivilegedCredentialGate {
  private credential: Buffer | undefined;

  install(value: unknown): void {
    if (this.credential) return;
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
      throw new Error("privileged credential 非法");
    }
    this.credential = Buffer.from(value, "utf8");
  }

  assert(value: unknown): void {
    if (!this.credential || typeof value !== "string") {
      throw new Error("PRIVILEGED_UNAVAILABLE: 特权确认通道不可用");
    }
    const candidate = Buffer.from(value, "utf8");
    if (candidate.length !== this.credential.length || !timingSafeEqual(candidate, this.credential)) {
      throw new Error("PRIVILEGED_DENIED: 特权确认凭证无效");
    }
  }

  ready(): boolean {
    return Boolean(this.credential);
  }
}

const gate = new PrivilegedCredentialGate();

export function installPrivilegedCredential(value: unknown): void {
  gate.install(value);
}

export function assertPrivilegedCredential(value: unknown): void {
  gate.assert(value);
}

