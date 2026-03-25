import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import { join } from "node:path";

export interface DiscoverRuntimeCoreModelRegistryInput {
  agentDir: string;
}

export function discoverRuntimeCoreModelRegistry(
  input: DiscoverRuntimeCoreModelRegistryInput
): ModelRegistry {
  const authStorage = AuthStorage.create(join(input.agentDir, "auth.json"));
  return new ModelRegistry(authStorage, join(input.agentDir, "models.json"));
}
