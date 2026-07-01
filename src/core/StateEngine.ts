import {
  SessionRepository,
  ActionRegistry,
  UserPreferenceRepository,
  Session
} from "./interfaces";
import { ExecutionContext, createExecutionContext } from "./ExecutionContext";
import { UIResolver } from "./UIResolver";

export interface StateEngineOptions {
  sessionRepository: SessionRepository;
  actionRegistry: ActionRegistry;
  preferenceRepository?: UserPreferenceRepository;
  uiResolver: UIResolver;
  sessionTtlMs?: number; // Inactivity timeout in ms (e.g. 15 mins)
}

export interface StateEngine {
  advance(
    phone: string,
    workflowConfig: any,
    userInput: string | null,
    buttonPayload: string | null
  ): Promise<any[]>;
}

export function createStateEngine(options: StateEngineOptions): StateEngine {
  const {
    sessionRepository,
    actionRegistry,
    preferenceRepository,
    uiResolver,
    sessionTtlMs = 10 * 60 * 1000 // 10 minutes default
  } = options;

  function createDefaultSession(phone: string, initialState: string): Session {
    return {
      phoneNumber: phone,
      currentState: initialState,
      language: "en",
      contextData: {},
      createdAt: new Date(),
      updatedAt: new Date()
    };
  }

  return {
    async advance(
      phone: string,
      workflowConfig: any,
      userInput: string | null,
      buttonPayload: string | null
    ): Promise<any[]> {
      // 1. Load Session
      let session = await sessionRepository.get(phone);
      const now = new Date();
      let sessionResetNotification = false;

      if (session) {
        // Session inactivity check: reset if expired
        const timeDiff = now.getTime() - new Date(session.updatedAt).getTime();
        if (timeDiff > sessionTtlMs) {
          session = createDefaultSession(phone, workflowConfig.initialState);
          sessionResetNotification = true;
        }
      } else {
        session = createDefaultSession(phone, workflowConfig.initialState);
      }

      // 2. Load Language Preference (if preference repository is injected)
      let activeLanguage = session.language;
      if (preferenceRepository) {
        const prefs = await preferenceRepository.get(phone);
        if (prefs) {
          activeLanguage = prefs.language;
          session.language = activeLanguage;
        }
      }

      // 3. Instantiate Execution Context
      const ctx = createExecutionContext(
        phone,
        session.contextData,
        userInput,
        buttonPayload,
        activeLanguage
      );

      // Add session reset notification if applicable
      if (sessionResetNotification) {
        let expiredMessage = "Your session has expired. Please start again.";
        if (uiResolver.translationProvider) {
          expiredMessage = uiResolver.translationProvider("sessionExpired", activeLanguage) || expiredMessage;
        }
        ctx.addMessage({
          type: "text",
          text: { body: expiredMessage }
        });
      }

      // 4. Resolve Trigger from current state
      const currentStateName = session.currentState;
      const currentStateConfig = workflowConfig.states[currentStateName];

      if (!currentStateConfig) {
        throw new Error(`Current state "${currentStateName}" not found in workflow configuration.`);
      }

      let trigger = "default";
      const currentStateAction = currentStateConfig.action || currentStateConfig.actionHook;

      if (currentStateAction && currentStateAction !== "renderUI") {
        // Current state requires validation or parsing action handler
        const handler = actionRegistry.get(currentStateAction);
        if (!handler) {
          throw new Error(`No action handler registered for current state hook "${currentStateAction}".`);
        }
        const response = await handler(ctx, currentStateConfig.params);
        if (response.updatedData) {
          ctx.updateData(response.updatedData);
        }
        if (response.updatedData?.language) {
          ctx.language = response.updatedData.language;
          session.language = response.updatedData.language;
          if (preferenceRepository) {
            await preferenceRepository.save(phone, {
              phoneNumber: phone,
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
          if (uiResolver.translationProvider && errKey) {
            errorMessage = uiResolver.translationProvider(errKey, ctx.language) || errorMessage;
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
            const messageUi = uiResolver.resolve(nextStateConfig, ctx);
            ctx.addMessage(messageUi);
          }
          await sessionRepository.delete(phone);
          return ctx.messages;
        }

        if (nextStateConfig.type === "action") {
          const actionHook = nextStateConfig.action || nextStateConfig.actionHook;
          if (!actionHook) {
            throw new Error(`Action state "${nextStateName}" is missing actionHook or action definition.`);
          }

          const handler = actionRegistry.get(actionHook);
          if (!handler) {
            throw new Error(`No action handler registered for hook "${actionHook}".`);
          }

          const response = await handler(ctx, nextStateConfig.params);
          if (response.updatedData) {
            ctx.updateData(response.updatedData);
          }

          if (response.updatedData?.language) {
            ctx.language = response.updatedData.language;
            session.language = response.updatedData.language;
            if (preferenceRepository) {
              await preferenceRepository.save(phone, {
                phoneNumber: phone,
                language: response.updatedData.language
              });
            }
          }

          const actionTransitions = nextStateConfig.transitions || {};
          nextStateName = actionTransitions[response.transition] || actionTransitions["default"];
        } else if (nextStateConfig.type === "message") {
          // Render UI for message state and add it to message queue
          const messageUi = uiResolver.resolve(nextStateConfig, ctx);
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

        const landingUi = uiResolver.resolve(nextStateConfig, ctx);
        if (landingUi && (landingUi.type !== "text" || (landingUi.text && landingUi.text.body))) {
          ctx.addMessage(landingUi);
        }

        session.currentState = nextStateName;
        session.contextData = ctx.sessionData;
        session.updatedAt = new Date();

        if (nextStateConfig.termination) {
          await sessionRepository.delete(phone);
        } else {
          await sessionRepository.save(phone, session);
        }
      } else {
        // If we run out of states and no state is active, clear session
        await sessionRepository.delete(phone);
      }

      return ctx.messages;
    }
  };
}
