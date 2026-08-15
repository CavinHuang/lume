/** Layered tool registry: global → preset → agent, resolved at assembly time. */

import type { ToolDefinition } from "../types.js";
import { matchesAnyToolPattern } from "../utils/tool-approval.js";

export interface ToolMask {
  allow?: string[];
  deny?: string[];
}

export interface RegistryView {
  visible(): ToolDefinition[];
  split(): { core: ToolDefinition[]; deferred: ToolDefinition[] };
}

export interface LayerHandle {
  register(tools: ToolDefinition[]): () => void;
  setCore(names: string[]): void;
  restrict(mask: ToolMask): () => void;
}

export interface ToolRegistry {
  global: LayerHandle;
  preset(key: string): LayerHandle;
  agent(id: string): LayerHandle & { view(): RegistryView };
}

interface Layer {
  tools: Map<string, ToolDefinition>;
  order: string[];
  core: Set<string> | undefined;
  masks: ToolMask[];
}

const RESERVED = new Set(["ToolSearch", "ExecuteTool"]);

function newLayer(): Layer {
  return { tools: new Map(), order: [], core: undefined, masks: [] };
}

function handle(layer: Layer): LayerHandle {
  return {
    register(tools) {
      for (const t of tools) {
        if (!layer.tools.has(t.name)) layer.order.push(t.name);
        layer.tools.set(t.name, t);
      }
      return () => {
        for (const t of tools) {
          layer.tools.delete(t.name);
          const index = layer.order.indexOf(t.name);
          if (index >= 0) layer.order.splice(index, 1);
        }
      };
    },
    setCore(names) {
      layer.core = new Set(names);
    },
    restrict(mask) {
      layer.masks.push(mask);
      return () => {
        const index = layer.masks.indexOf(mask);
        if (index >= 0) layer.masks.splice(index, 1);
      };
    },
  };
}

export function createToolRegistry(): ToolRegistry {
  const globalLayer = newLayer();
  const presets = new Map<string, Layer>();
  const agents = new Map<string, Layer>();

  const layerOf = (map: Map<string, Layer>, key: string): Layer => {
    let layer = map.get(key);
    if (!layer) map.set(key, (layer = newLayer()));
    return layer;
  };

  const chain = (id: string): Layer[] => [globalLayer, layerOf(presets, "default"), layerOf(agents, id)];

  const merged = (id: string): { byName: Map<string, ToolDefinition>; order: string[] } => {
    const byName = new Map<string, ToolDefinition>();
    const order: string[] = [];
    for (const layer of chain(id)) {
      for (const name of layer.order) {
        const t = layer.tools.get(name);
        if (!t) continue;
        if (!byName.has(name)) order.push(name);
        byName.set(name, t);
      }
    }
    return { byName, order };
  };

  return {
    global: handle(globalLayer),
    preset: (key) => handle(layerOf(presets, key)),
    agent: (id) => {
      const layer = layerOf(agents, id);
      const view: RegistryView = {
        visible() {
          const { byName, order } = merged(id);
          const masks = chain(id).flatMap((l) => l.masks);
          const allows = masks.map((m) => m.allow).filter((a): a is string[] => !!a && a.length > 0);
          const denies = masks.flatMap((m) => m.deny ?? []);
          return order
            .map((name) => byName.get(name)!)
            .filter((t) => allows.every((a) => matchesAnyToolPattern(t.name, a)))
            .filter((t) => !matchesAnyToolPattern(t.name, denies));
        },
        split() {
          const visible = this.visible().filter((t) => !RESERVED.has(t.name));
          const core = chain(id).reverse().find((l) => l.core !== undefined)?.core ?? new Set<string>();
          return {
            core: visible.filter((t) => core.has(t.name) || t.runtimeMetadata?.requiredDuringSkillScope === true),
            deferred: visible.filter((t) => !core.has(t.name) && t.runtimeMetadata?.requiredDuringSkillScope !== true),
          };
        },
      };
      return { ...handle(layer), view: () => view };
    },
  };
}
