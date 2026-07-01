export interface ExecutionContext {
  readonly phoneNumber: string;
  sessionData: Record<string, any>;
  readonly userInput: string | null;
  readonly buttonPayload: string | null;
  language: string;
  readonly messages: Array<any>;
  updateData(data: Record<string, any>): void;
  addMessage(payload: any): void;
  getLanguage(): string;
}

export function createExecutionContext(
  phoneNumber: string,
  sessionData: Record<string, any>,
  userInput: string | null,
  buttonPayload: string | null,
  language: string
): ExecutionContext {
  const context: ExecutionContext = {
    phoneNumber,
    sessionData: { ...sessionData },
    userInput,
    buttonPayload,
    language,
    messages: [],
    updateData(data: Record<string, any>): void {
      context.sessionData = { ...context.sessionData, ...data };
    },
    addMessage(payload: any): void {
      context.messages.push(payload);
    },
    getLanguage(): string {
      return context.language;
    }
  };
  return context;
}
