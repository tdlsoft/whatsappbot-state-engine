import { ExecutionContext } from "./ExecutionContext";

export interface Session {
  phoneNumber: string;
  currentState: string;
  language: string;
  contextData: Record<string, any>;
  updatedAt: Date;
  createdAt: Date;
}

export interface SessionRepository {
  get(phone: string): Promise<Session | null>;
  save(phone: string, session: Session): Promise<void>;
  delete(phone: string): Promise<void>;
}

export interface ActionResponse {
  transition: string;
  updatedData?: Record<string, any>;
}

export type ActionHandler = (ctx: ExecutionContext, params?: any) => Promise<ActionResponse>;

export interface ActionRegistry {
  get(name: string): ActionHandler | null;
  register(name: string, handler: ActionHandler): void;
}

export interface UserPreferences {
  phoneNumber: string;
  language: string;
}

export interface UserPreferenceRepository {
  get(phone: string): Promise<UserPreferences | null>;
  save(phone: string, preferences: UserPreferences): Promise<void>;
}

export type TranslationProvider = (key: string, locale: string, placeholders?: Record<string, string>) => string;

export interface Logger {
  info(message: string, meta?: any): void;
  warn(message: string, meta?: any): void;
  error(message: string, meta?: any): void;
  debug(message: string, meta?: any): void;
}


export interface WorkflowState {
  actor?: "user" | "bot" | string;
  type?: "message" | "prompt" | "action" | "input" | string;
  message?: string | string[] | any;
  messageKey?: string;
  action?: string;
  actionHook?: string;
  preActionStep?: string;
  dynamicSource?: string;
  buttons?: any[];
  params?: any;
  transitions?: Record<string, string>;
  termination?: boolean;
  suppressPromptOnSelfTransition?: boolean;
  errorMessageKey?: string;
  listButtonText?: string;
  listSectionTitle?: string;
  [key: string]: any;
}

export interface WorkflowConfig {
  initialState: string;
  states: Record<string, WorkflowState>;
  [key: string]: any;
}
