import { PermissionEngine } from "./permission-engine";
import type {
  PermissionDecision,
  PermissionDecisionInput
} from "./permission-types";

export interface PermissionRuntimeOptions {
  engine?: PermissionEngine;
}

export class PermissionRuntime {
  private readonly engine: PermissionEngine;

  constructor(options: PermissionRuntimeOptions = {}) {
    this.engine = options.engine ?? new PermissionEngine();
  }

  authorize(input: PermissionDecisionInput): Promise<PermissionDecision> {
    return this.engine.decide(input);
  }
}
