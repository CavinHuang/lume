import { canonicalizeAgentToolName } from "@lume/shared";
import type { LumeToolDescriptor } from "./tool-types";

const descriptorsBySession = new Map<string, Map<string, LumeToolDescriptor>>();

export function setRuntimeToolDescriptors(sessionId: string, descriptors: LumeToolDescriptor[]): void {
  descriptorsBySession.set(
    sessionId,
    new Map(descriptors.map((descriptor) => [descriptor.canonicalName, descriptor]))
  );
}

export function appendRuntimeToolDescriptors(sessionId: string, descriptors: LumeToolDescriptor[]): void {
  const registered = descriptorsBySession.get(sessionId) ?? new Map<string, LumeToolDescriptor>();
  for (const descriptor of descriptors) {
    registered.set(descriptor.canonicalName, descriptor);
  }
  descriptorsBySession.set(sessionId, registered);
}

export function getRuntimeToolDescriptor(sessionId: string, toolName: string): LumeToolDescriptor | undefined {
  return descriptorsBySession.get(sessionId)?.get(canonicalizeAgentToolName(toolName));
}

export function clearRuntimeToolDescriptors(sessionId: string): void {
  descriptorsBySession.delete(sessionId);
}
