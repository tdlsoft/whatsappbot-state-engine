import { TranslationProvider, Logger } from "./interfaces";
import { ExecutionContext } from "./ExecutionContext";

export interface UIResolverOptions {
  translationProvider?: TranslationProvider;
  logger?: Logger;
}

export interface UIResolver {
  resolve(stateConfig: any, ctx: ExecutionContext): any;
  translationProvider?: TranslationProvider;
  logger?: Logger;
}

export function createUIResolver(options?: UIResolverOptions): UIResolver {
  const translationProvider = options?.translationProvider;
  const logger = options?.logger;

  return {
    resolve(stateConfig: any, ctx: ExecutionContext): any {
      const locale = ctx.getLanguage();

      // 1. Resolve body text
      let bodyText = "";
      const rawMessage = stateConfig.message;
      if (Array.isArray(rawMessage)) {
        bodyText = rawMessage.join("\n");
      } else if (typeof rawMessage === "string") {
        bodyText = rawMessage;
      } else if (rawMessage && typeof rawMessage === "object") {
        bodyText = rawMessage.text || "";
      }

      const translationKey = stateConfig.messageKey || (rawMessage && typeof rawMessage === "object" ? rawMessage.translationKey : undefined);

      if (translationProvider && translationKey) {
        const placeholders = {
          ...ctx.sessionData,
          ...(stateConfig.params || {}),
          ...(rawMessage && typeof rawMessage === "object" ? rawMessage.placeholders : {})
        };
        const translated = translationProvider(translationKey, locale, placeholders);
        if (translated) {
          bodyText = translated;
        }
      }

      // Interpolate placeholders {{key}} into bodyText from sessionData and params
      const placeholders: Record<string, any> = {
        ...ctx.sessionData,
        ...(stateConfig.params || {}),
        ...(rawMessage && typeof rawMessage === "object" ? rawMessage.placeholders : {})
      };
      for (const [key, value] of Object.entries(placeholders)) {
        if (value !== undefined && value !== null) {
          bodyText = bodyText.split(`{{${key}}}`).join(String(value));
        }
      }

      // 2. Resolve options
      let optionsList = stateConfig.buttons || (rawMessage && typeof rawMessage === "object" ? rawMessage.buttons : []) || [];
      if (translationProvider) {
        optionsList = optionsList.map((opt: any) => ({
          ...opt,
          label: translationProvider(opt.label, locale) || opt.label
        }));
      }

      // 3. Fallback to simple text message if no options are present or if type is message
      if (optionsList.length === 0 || stateConfig.type === "message") {
        logger?.debug?.(`Resolving UI as plain text message for state: ${stateConfig.name || "unknown"}`);
        return {
          type: "text",
          text: { body: bodyText }
        };
      }

      // 4. Check character limits and count for WhatsApp components
      const maxButtons = 3;
      const maxButtonLabelLength = 20;
      const maxListItems = 10;

      const hasLongLabel = optionsList.some((opt: any) => opt.label.length > maxButtonLabelLength);

      if (optionsList.length <= maxButtons && !hasLongLabel) {
        // Format as Quick Reply Buttons
        logger?.debug?.(`Resolving UI as Quick Reply Buttons for state: ${stateConfig.name || "unknown"} (options count: ${optionsList.length})`);
        return {
          type: "interactive",
          interactive: {
            type: "button",
            body: { text: bodyText },
            action: {
              buttons: optionsList.map((opt: any) => ({
                type: "reply",
                reply: {
                  id: opt.value,
                  title: opt.label
                }
              }))
            }
          }
        };
      } else if (optionsList.length <= maxListItems) {
        // Format as List Message (Dropdown)
        if (optionsList.length > maxButtons) {
          logger?.debug?.(`UI formatted as List Message because option count (${optionsList.length}) exceeds max quick reply buttons (${maxButtons})`);
        } else if (hasLongLabel) {
          logger?.debug?.(`UI formatted as List Message because one or more button labels exceed max length of ${maxButtonLabelLength} chars`);
        }

        const listButtonText = stateConfig.listButtonText || (rawMessage && typeof rawMessage === "object" ? rawMessage.listButtonText : undefined) || "Select Option";
        const listSectionTitle = stateConfig.listSectionTitle || (rawMessage && typeof rawMessage === "object" ? rawMessage.listSectionTitle : undefined) || "Options";

        return {
          type: "interactive",
          interactive: {
            type: "list",
            body: { text: bodyText },
            action: {
              button: listButtonText,
              sections: [
                {
                  title: listSectionTitle,
                  rows: optionsList.map((opt: any) => ({
                    id: opt.value,
                    title: opt.label.substring(0, 24), // Meta title limit is 24 chars
                    description: opt.description ? opt.description.substring(0, 72) : ""
                  }))
                }
              ]
            }
          }
        };
      } else {
        // Format as Numbered Text Menu
        logger?.warn?.(`Option count (${optionsList.length}) exceeds maximum limit for interactive list (${maxListItems}) in state ${stateConfig.name || "unknown"}. Falling back to Numbered Text Menu.`);
        let textMenu = bodyText + "\n\n";
        optionsList.forEach((opt: any, index: number) => {
          textMenu += `${index + 1}. ${opt.label}\n`;
        });
        return {
          type: "text",
          text: { body: textMenu.trim() }
        };
      }
    },
    translationProvider,
    logger
  };
}
