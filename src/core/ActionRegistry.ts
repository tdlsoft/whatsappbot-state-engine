import { ActionRegistry, ActionHandler } from "./interfaces";

export function createActionRegistry(): ActionRegistry {
  const registry = new Map<string, ActionHandler>();

  return {
    register(name: string, handler: ActionHandler): void {
      registry.set(name, handler);
    },
    get(name: string): ActionHandler | null {
      return registry.get(name) || null;
    }
  };
}
