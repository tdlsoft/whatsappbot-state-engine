import {
  SessionRepository,
  ActionRegistry,
  UserPreferenceRepository,
  Session,
  Logger
} from "./interfaces";
import { ExecutionContext, createExecutionContext } from "./ExecutionContext";
import { UIResolver } from "./UIResolver";

export interface StateEngineOptions {
  sessionRepository: SessionRepository;
  actionRegistry: ActionRegistry;
  preferenceRepository?: UserPreferenceRepository;
  uiResolver: UIResolver;
  sessionTtlMs?: number; // Inactivity timeout in ms (e.g. 15 mins)
  logger?: Logger;
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
    sessionTtlMs = 10 * 60 * 1000, // 10 minutes default
    logger
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
      logger?.debug?.(`Loading session for phone number: ${phone}`);
      let session = await sessionRepository.get(phone);
      const now = new Date();
      let sessionResetNotification = false;

      if (session) {
        logger?.info?.(`Loaded active session for phone: ${phone}. Current state: ${session.currentState}`);
        // Session inactivity check: reset if expired
        const timeDiff = now.getTime() - new Date(session.updatedAt).getTime();
        if (timeDiff > sessionTtlMs) {
          logger?.warn?.(`Session expired for phone: ${phone}. Resetting to initial state: ${workflowConfig.initialState}`);
          session = createDefaultSession(phone, workflowConfig.initialState);
          sessionResetNotification = true;
        }
      } else {
        logger?.info?.(`No session found for phone: ${phone}. Creating new session at initial state: ${workflowConfig.initialState}`);
        session = createDefaultSession(phone, workflowConfig.initialState);
      }

      // 2. Load Language Preference (if preference repository is injected)
      logger?.debug?.(`Loading language preference for phone: ${phone}`);
      let activeLanguage = session.language;
      if (preferenceRepository) {
        const prefs = await preferenceRepository.get(phone);
        if (prefs) {
          activeLanguage = prefs.language;
          session.language = activeLanguage;
          logger?.debug?.(`Language preference found: ${activeLanguage}`);
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
        const err = `Current state "${currentStateName}" not found in workflow configuration.`;
        logger?.error?.(err);
        throw new Error(err);
      }

      let trigger = "default";
      const currentStateAction = currentStateConfig.action || currentStateConfig.actionHook;

      if (currentStateAction && currentStateAction !== "renderUI") {
        // Current state requires validation or parsing action handler
        logger?.info?.(`Executing action handler for current state validation: ${currentStateAction}`, { state: currentStateName });
        const handler = actionRegistry.get(currentStateAction);
        if (!handler) {
          const err = `No action handler registered for current state hook "${currentStateAction}".`;
          logger?.error?.(err);
          throw new Error(err);
        }
        const response = await handler(ctx, currentStateConfig.params);
        logger?.info?.(`Action handler ${currentStateAction} resolved trigger: ${response.transition}`, { response });
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
        logger?.debug?.(`Resolving user input trigger for state: ${currentStateName}`, { userInput, buttonPayload });
        if (buttonPayload) {
          trigger = buttonPayload;
          logger?.info?.(`Matched button payload trigger: ${trigger}`, { state: currentStateName });
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
            logger?.info?.(`Matched text option trigger: ${trigger} for input: "${userInput}"`, { state: currentStateName });
          } else {
            // If state expects options but input was not matched, mark it as invalid
            const hasOptions = buttons.length > 0;
            const allowedInputs = currentStateConfig.allowedInputs || [];
            if (hasOptions || allowedInputs.length > 0) {
              trigger = "invalid_input";
              logger?.warn?.(`Invalid user input received for options: "${userInput}"`, { state: currentStateName });
            } else {
              logger?.debug?.(`No options defined, falling back to default trigger for input: "${userInput}"`);
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
          logger?.warn?.(`Transition not found for trigger: "${trigger}". Staying in current state: ${currentStateName} (Validation failure)`);
        } else {
          const err = `No transition defined for state "${currentStateName}" with trigger "${trigger}".`;
          logger?.error?.(err);
          throw new Error(err);
        }
      } else {
        logger?.info?.(`Resolved transition: State ${currentStateName} -> Trigger ${trigger} -> State ${nextStateName}`);
      }

      // 6. Auto-Advance Loop (traverses states belonging to the bot)
      let loopCount = 0;
      const maxLoopCount = 10;
      let nextStateConfig = workflowConfig.states[nextStateName];

      while (nextStateConfig && nextStateConfig.actor === "bot") {
        loopCount++;
        logger?.debug?.(`Auto-advancing: State ${nextStateName} (Loop count: ${loopCount})`);
        if (loopCount > maxLoopCount) {
          const err = `Infinite loop detected: exceeded ${maxLoopCount} sequential auto-advances.`;
          logger?.error?.(err);
          throw new Error(err);
        }

        // Handle immediate termination state
        if (nextStateConfig.termination) {
          logger?.info?.(`Termination state reached at: ${nextStateName}`);
          if (nextStateConfig.type === "message") {
            const messageUi = uiResolver.resolve(nextStateConfig, ctx);
            ctx.addMessage(messageUi);
          }
          logger?.info?.(`Deleting session on termination: ${phone}`);
          await sessionRepository.delete(phone);
          return ctx.messages;
        }

        if (nextStateConfig.type === "action") {
          const actionHook = nextStateConfig.action || nextStateConfig.actionHook;
          if (!actionHook) {
            const err = `Action state "${nextStateName}" is missing actionHook or action definition.`;
            logger?.error?.(err);
            throw new Error(err);
          }

          logger?.info?.(`Executing auto-advance action hook: ${actionHook} in state: ${nextStateName}`);
          const handler = actionRegistry.get(actionHook);
          if (!handler) {
            const err = `No action handler registered for hook "${actionHook}".`;
            logger?.error?.(err);
            throw new Error(err);
          }

          const response = await handler(ctx, nextStateConfig.params);
          logger?.info?.(`Action hook ${actionHook} resolved transition: ${response.transition}`, { response });
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
          const prevNextState = nextStateName;
          nextStateName = actionTransitions[response.transition] || actionTransitions["default"];
          logger?.debug?.(`Action state transition resolved: ${prevNextState} -> ${nextStateName}`);
        } else if (nextStateConfig.type === "message") {
          // Render UI for message state and add it to message queue
          logger?.info?.(`Rendering UI message for state: ${nextStateName}`);
          const messageUi = uiResolver.resolve(nextStateConfig, ctx);
          ctx.addMessage(messageUi);

          const messageTransitions = nextStateConfig.transitions || {};
          const prevNextState = nextStateName;
          nextStateName = messageTransitions["default"];
          logger?.debug?.(`Message state transition resolved: ${prevNextState} -> ${nextStateName}`);
        }

        if (!nextStateName) {
          logger?.debug?.(`No next state defined, breaking out of auto-advance loop.`);
          break;
        }
        nextStateConfig = workflowConfig.states[nextStateName];
      }

      // 7. Render UI for the final landing state (if not already handled or terminated)
      if (nextStateName) {
        if (!nextStateConfig) {
          const err = `Landing state "${nextStateName}" not found in workflow configuration.`;
          logger?.error?.(err);
          throw new Error(err);
        }

        const isSameState = nextStateName === currentStateName;
        const alreadyHasMessage = ctx.messages.length > 0;
        const shouldSuppress = nextStateConfig.suppressPromptOnSelfTransition;

        if (!isSameState || !alreadyHasMessage || !shouldSuppress) {
          logger?.info?.(`Resolving landing UI for state: ${nextStateName}`);
          const landingUi = uiResolver.resolve(nextStateConfig, ctx);
          if (landingUi && (landingUi.type !== "text" || (landingUi.text && landingUi.text.body))) {
            ctx.addMessage(landingUi);
          }
        }

        session.currentState = nextStateName;
        session.contextData = ctx.sessionData;
        session.updatedAt = new Date();

        if (nextStateConfig.termination) {
          logger?.info?.(`Landing state is termination. Deleting session for phone: ${phone}`);
          await sessionRepository.delete(phone);
        } else {
          logger?.info?.(`Saving session. Current state: ${session.currentState} for phone: ${phone}`);
          await sessionRepository.save(phone, session);
        }
      } else {
        // If we run out of states and no state is active, clear session
        logger?.info?.(`No active state remains. Deleting session for phone: ${phone}`);
        await sessionRepository.delete(phone);
      }

      return ctx.messages;
    }
  };
}
