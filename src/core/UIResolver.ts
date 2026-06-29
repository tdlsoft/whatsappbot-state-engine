import { ITranslationProvider } from "./interfaces";
import { ExecutionContext } from "./ExecutionContext";

export interface UIResolverOptions {
  translationProvider?: ITranslationProvider;
}

export class UIResolver {
  private translationProvider?: ITranslationProvider;

  constructor(options?: UIResolverOptions) {
    this.translationProvider = options?.translationProvider;
  }

  /**
   * Resolves a state render configuration to a platform-specific WhatsApp message schema.
   */
  public resolve(stateConfig: any, ctx: ExecutionContext): any {
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
    
    if (this.translationProvider && translationKey) {
      const placeholders = {
        ...ctx.session_data,
        ...(stateConfig.params || {}),
        ...(rawMessage && typeof rawMessage === "object" ? rawMessage.placeholders : {})
      };
      const translated = this.translationProvider.translate(translationKey, locale, placeholders);
      if (translated) {
        bodyText = translated;
      }
    }

    // 2. Resolve options
    let options = stateConfig.buttons || (rawMessage && typeof rawMessage === "object" ? rawMessage.buttons : []) || [];
    if (this.translationProvider) {
      options = options.map((opt: any) => ({
        ...opt,
        label: this.translationProvider!.translate(opt.label, locale) || opt.label
      }));
    }
    
    // 3. Fallback to simple text message if no options are present or if type is message
    if (options.length === 0 || stateConfig.type === "message") {
      return {
        type: "text",
        text: { body: bodyText }
      };
    }

    // 4. Check character limits and count for WhatsApp components
    const maxButtons = 3;
    const maxButtonLabelLength = 20;
    const maxListItems = 10;

    const hasLongLabel = options.some((opt: any) => opt.label.length > maxButtonLabelLength);

    if (options.length <= maxButtons && !hasLongLabel) {
      // Format as Quick Reply Buttons
      return {
        type: "interactive",
        interactive: {
          type: "button",
          body: { text: bodyText },
          action: {
            buttons: options.map((opt: any) => ({
              type: "reply",
              reply: {
                id: opt.value,
                title: opt.label
              }
            }))
          }
        }
      };
    } else if (options.length <= maxListItems) {
      // Format as List Message (Dropdown)
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
                rows: options.map((opt: any) => ({
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
      let textMenu = bodyText + "\n\n";
      options.forEach((opt: any, index: number) => {
        textMenu += `${index + 1}. ${opt.label}\n`;
      });
      return {
        type: "text",
        text: { body: textMenu.trim() }
      };
    }
  }
}
