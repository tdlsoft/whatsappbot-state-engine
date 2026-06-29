export class ExecutionContext {
  public readonly phone_number: string;
  public session_data: Record<string, any>;
  public readonly user_input: string | null;
  public readonly button_payload: string | null;
  public language: string;
  public messages: Array<any> = [];

  constructor(
    phone_number: string,
    session_data: Record<string, any>,
    user_input: string | null,
    button_payload: string | null,
    language: string
  ) {
    this.phone_number = phone_number;
    this.session_data = session_data;
    this.user_input = user_input;
    this.button_payload = button_payload;
    this.language = language;
  }

  public updateData(data: Record<string, any>): void {
    this.session_data = { ...this.session_data, ...data };
  }

  public addMessage(payload: any): void {
    this.messages.push(payload);
  }

  public getLanguage(): string {
    return this.language;
  }
}
