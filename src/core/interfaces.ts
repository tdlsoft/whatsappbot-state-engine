import { ExecutionContext } from "./ExecutionContext";

export interface Session {
  phone_number: string;
  current_state: string;
  language: string;
  context_data: Record<string, any>;
  updated_at: Date;
  created_at: Date;
}

export interface ISessionRepository {
  get(phone: string): Promise<Session | null>;
  save(phone: string, session: Session): Promise<void>;
  delete(phone: string): Promise<void>;
}

export interface ActionResponse {
  transition: string;
  updatedData?: Record<string, any>;
}

export interface IActionHandler {
  execute(ctx: ExecutionContext, params?: any): Promise<ActionResponse>;
}

export interface IActionRegistry {
  get(name: string): IActionHandler | null;
  register(name: string, handler: IActionHandler): void;
}

export interface UserPreferences {
  phone_number: string;
  language: string;
}

export interface IUserPreferenceRepository {
  get(phone: string): Promise<UserPreferences | null>;
  save(phone: string, preferences: UserPreferences): Promise<void>;
}

export interface ITranslationProvider {
  translate(key: string, locale: string, placeholders?: Record<string, string>): string;
}
