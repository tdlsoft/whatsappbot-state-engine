import { IActionRegistry, IActionHandler } from "./interfaces";

export class ActionRegistry implements IActionRegistry {
  private registry: Map<string, IActionHandler> = new Map();

  public register(name: string, handler: IActionHandler): void {
    this.registry.set(name, handler);
  }

  public get(name: string): IActionHandler | null {
    return this.registry.get(name) || null;
  }
}
