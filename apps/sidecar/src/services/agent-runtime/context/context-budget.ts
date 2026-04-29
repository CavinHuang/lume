export interface ContextBudget {
  total: number;
  system: number;
  dynamic: number;
  memory: number;
  session: number;
  toolSchemas: number;
  reservedOutput: number;
}

export const DEFAULT_CONTEXT_BUDGET: ContextBudget = {
  total: 1,
  system: 0.25,
  dynamic: 0.15,
  memory: 0.20,
  session: 0.25,
  toolSchemas: 0.10,
  reservedOutput: 0.05
};
