import { 
  ISessionRepository, 
  IActionRegistry, 
  IUserPreferenceRepository, 
  Session 
} from "./interfaces";
import { ExecutionContext } from "./ExecutionContext";
import { UIResolver } from "./UIResolver";

export interface StateEngineOptions {
  sessionRepository: ISessionRepository;
  actionRegistry: IActionRegistry;
  preferenceRepository?: IUserPreferenceRepository;
  uiResolver: UIResolver;
  sessionTtlMs?: number; // Inactivity timeout in ms (e.g. 15 mins)
}

export class StateEngine {
  private sessionRepository: ISessionRepository;
  private actionRegistry: IActionRegistry;
  private preferenceRepository?: IUserPreferenceRepository;
  private uiResolver: UIResolver;
  private sessionTtlMs: number;

  constructor(options: StateEngineOptions) {
    this.sessionRepository = options.sessionRepository;
    this.actionRegistry = options.actionRegistry;
    this.preferenceRepository = options.preferenceRepository;
    this.uiResolver = options.uiResolver;
    this.sessionTtlMs = options.sessionTtlMs || 10 * 60 * 1000; // 10 minutes default based on FR-14
  }

  /**
   * Main entry point to advance the state machine.
   */
  public async advance(
    phone: string,
    workflowConfig: any,
    userInput: string | null,
    buttonPayload: string | null
  ): Promise<any[]> {
    // 1. Load Session
    let session = await this.sessionRepository.get(phone);
    const now = new Date();
    let sessionResetNotification = false;

    if (session) {
      // Session inactivity check: reset if expired
      const timeDiff = now.getTime() - new Date(session.updated_at).getTime();
      if (timeDiff > this.sessionTtlMs) {
        session = this.createDefaultSession(phone, workflowConfig.initialState);
        sessionResetNotification = true;
      }
    } else {
      session = this.createDefaultSession(phone, workflowConfig.initialState);
    }

    // 2. Load Language Preference (if preference repository is injected)
    let activeLanguage = session.language;
    if (this.preferenceRepository) {
      const prefs = await this.preferenceRepository.get(phone);
      if (prefs) {
        activeLanguage = prefs.language;
        session.language = activeLanguage;
      }
    }

    // 3. Instantiate Execution Context
    const ctx = new ExecutionContext(
      phone,
      session.context_data,
      userInput,
      buttonPayload,
      activeLanguage
    );

    // Add session reset notification if applicable
    if (sessionResetNotification) {
      let expiredMessage = "Your session has expired. Please start again.";
      if (this.uiResolver["translationProvider"]) {
        expiredMessage = this.uiResolver["translationProvider"].translate("sessionExpired", activeLanguage) || expiredMessage;
      }
      ctx.addMessage({
        type: "text",
        text: { body: expiredMessage }
      });
    }

    // 4. Resolve Trigger from current state
    const currentStateName = session.current_state;
    const currentStateConfig = workflowConfig.states[currentStateName];

    if (!currentStateConfig) {
      throw new Error(`Current state "${currentStateName}" not found in workflow configuration.`);
    }

    let trigger = "default";
    const currentStateAction = currentStateConfig.action || currentStateConfig.actionHook;

    if (currentStateAction && currentStateAction !== "renderUI") {
      // Current state requires validation or parsing action handler
      const handler = this.actionRegistry.get(currentStateAction);
      if (!handler) {
        throw new Error(`No action handler registered for current state hook "${currentStateAction}".`);
      }
      const response = await handler.execute(ctx, currentStateConfig.params);
      if (response.updatedData) {
        ctx.updateData(response.updatedData);
      }
      if (response.updatedData?.language) {
        ctx.language = response.updatedData.language;
        session.language = response.updatedData.language;
        if (this.preferenceRepository) {
          await this.preferenceRepository.save(phone, {
            phone_number: phone,
            language: response.updatedData.language
          });
        }
      }
      trigger = response.transition;
    } else {
      // Normal state trigger resolution
      if (buttonPayload) {
        trigger = buttonPayload;
      } else if (userInput) {
        const buttons = currentStateConfig.buttons || currentStateConfig.message?.buttons || [];
        
        // Match by option value, label (case-insensitive), or 1-based index (e.g. "1")
        const matchedOption = buttons.find(
          (btn: any, index: number) => 
            btn.value === userInput || 
            btn.label.trim().toLowerCase() === userInput.trim().toLowerCase() ||
            userInput.trim() === String(index + 1)
        );

        if (matchedOption) {
          trigger = matchedOption.value;
        } else {
          // If state expects options but input was not matched, mark it as invalid
          const hasOptions = buttons.length > 0;
          const allowedInputs = currentStateConfig.allowedInputs || [];
          if (hasOptions || allowedInputs.length > 0) {
            trigger = "invalid_input";
          }
        }
      }
    }

    // 5. Resolve target state
    const transitions = currentStateConfig.transitions || {};
    let nextStateName = transitions[trigger] || transitions["default"];

    if (!nextStateName) {
      if (currentStateConfig.actor === "user" && (currentStateConfig.type === "prompt" || currentStateConfig.type === "input")) {
        // For input validation failure, remain in current state and show error
        nextStateName = currentStateName;
        let errorMessage = "Invalid option. Please try again.";
        const errKey = currentStateConfig.errorMessageKey;
        if (this.uiResolver["translationProvider"] && errKey) {
          errorMessage = this.uiResolver["translationProvider"].translate(errKey, ctx.language) || errorMessage;
        }
        ctx.addMessage({
          type: "text",
          text: { body: errorMessage }
        });
      } else {
        throw new Error(`No transition defined for state "${currentStateName}" with trigger "${trigger}".`);
      }
    }

    // 6. Auto-Advance Loop (traverses states belonging to the bot)
    let loopCount = 0;
    const maxLoopCount = 10;
    let nextStateConfig = workflowConfig.states[nextStateName];

    while (nextStateConfig && nextStateConfig.actor === "bot") {
      loopCount++;
      if (loopCount > maxLoopCount) {
        throw new Error(`Infinite loop detected: exceeded ${maxLoopCount} sequential auto-advances.`);
      }

      // Handle immediate termination state
      if (nextStateConfig.termination) {
        if (nextStateConfig.type === "message") {
          const messageUi = this.uiResolver.resolve(nextStateConfig, ctx);
          ctx.addMessage(messageUi);
        }
        await this.sessionRepository.delete(phone);
        return ctx.messages;
      }

      if (nextStateConfig.type === "action") {
        const actionHook = nextStateConfig.action || nextStateConfig.actionHook;
        if (!actionHook) {
          throw new Error(`Action state "${nextStateName}" is missing actionHook or action definition.`);
        }

        const handler = this.actionRegistry.get(actionHook);
        if (!handler) {
          throw new Error(`No action handler registered for hook "${actionHook}".`);
        }

        const response = await handler.execute(ctx, nextStateConfig.params);
        if (response.updatedData) {
          ctx.updateData(response.updatedData);
        }

        if (response.updatedData?.language) {
          ctx.language = response.updatedData.language;
          session.language = response.updatedData.language;
          if (this.preferenceRepository) {
            await this.preferenceRepository.save(phone, {
              phone_number: phone,
              language: response.updatedData.language
            });
          }
        }

        const actionTransitions = nextStateConfig.transitions || {};
        nextStateName = actionTransitions[response.transition] || actionTransitions["default"];
      } else if (nextStateConfig.type === "message") {
        // Render UI for message state and add it to message queue
        const messageUi = this.uiResolver.resolve(nextStateConfig, ctx);
        ctx.addMessage(messageUi);

        const messageTransitions = nextStateConfig.transitions || {};
        nextStateName = messageTransitions["default"];
      }

      if (!nextStateName) {
        break;
      }
      nextStateConfig = workflowConfig.states[nextStateName];
    }

    // 7. Render UI for the final landing state (if not already handled or terminated)
    if (nextStateName) {
      if (!nextStateConfig) {
        throw new Error(`Landing state "${nextStateName}" not found in workflow configuration.`);
      }

      const landingUi = this.uiResolver.resolve(nextStateConfig, ctx);
      if (landingUi && (landingUi.type !== "text" || (landingUi.text && landingUi.text.body))) {
        ctx.addMessage(landingUi);
      }

      session.current_state = nextStateName;
      session.context_data = ctx.session_data;
      session.updated_at = new Date();

      if (nextStateConfig.termination) {
        await this.sessionRepository.delete(phone);
      } else {
        await this.sessionRepository.save(phone, session);
      }
    } else {
      // If we run out of states and no state is active, clear session
      await this.sessionRepository.delete(phone);
    }

    return ctx.messages;
  }

  private createDefaultSession(phone: string, initialState: string): Session {
    return {
      phone_number: phone,
      current_state: initialState,
      language: "en",
      context_data: {},
      created_at: new Date(),
      updated_at: new Date()
    };
  }
}
