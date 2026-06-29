import { StateEngine } from "../src/core/StateEngine";
import { ActionRegistry } from "../src/core/ActionRegistry";
import { UIResolver } from "../src/core/UIResolver";
import { Session, ISessionRepository, IUserPreferenceRepository, ITranslationProvider, UserPreferences, IActionHandler, ActionResponse } from "../src/core/interfaces";
import { ExecutionContext } from "../src/core/ExecutionContext";
import * as workflowConfig from "../workflows/anand-dairy.json";

// --- Local Time & Date Helpers ---

function getIstDateString(offsetDays: number = 0): string {
  const date = new Date();
  const utc = date.getTime() + date.getTimezoneOffset() * 60000;
  const istDate = new Date(utc + 3600000 * 5.5);
  if (offsetDays !== 0) {
    istDate.setDate(istDate.getDate() + offsetDays);
  }
  const day = String(istDate.getDate()).padStart(2, "0");
  const month = String(istDate.getMonth() + 1).padStart(2, "0");
  const year = istDate.getFullYear();
  return `${day}/${month}/${year}`;
}

function validateDate(dateStr: string): string | null {
  const cleanStr = dateStr.trim();
  const match = cleanStr.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return null;
  const day = parseInt(match[1], 10);
  const month = parseInt(match[2], 10) - 1;
  const year = parseInt(match[3], 10);

  const date = new Date(year, month, day);
  if (date.getDate() !== day || date.getMonth() !== month || date.getFullYear() !== year) {
    return null;
  }

  const todayStr = getIstDateString(0);
  const todayParts = todayStr.split("/");
  const todayDate = new Date(parseInt(todayParts[2]), parseInt(todayParts[1]) - 1, parseInt(todayParts[0]));

  const limitDate = new Date(todayDate);
  limitDate.setDate(limitDate.getDate() - 30);

  if (date > todayDate) return null;
  if (date < limitDate) return null;

  return cleanStr;
}

// --- Local Parsing Helpers ---

function parseProductionLine(line: string): { cow_name: string; morning: number; evening: number } | null {
  const parts = line.split(",");
  if (parts.length < 2) return null;
  const cow_name = parts[0].trim();
  if (!cow_name) return null;

  let morning = 0;
  let evening = 0;

  const rest = parts.slice(1).join(",");
  const morningMatch = rest.match(/(?:morning\s*milk|morning|m)\s*=\s*(\d+(?:\.\d+)?)/i);
  const eveningMatch = rest.match(/(?:evening\s*milk|evening|e)\s*=\s*(\d+(?:\.\d+)?)/i);

  if (!morningMatch && !eveningMatch) return null;

  if (morningMatch) morning = parseFloat(morningMatch[1]);
  if (eveningMatch) evening = parseFloat(eveningMatch[1]);

  return { cow_name, morning, evening };
}

function parseConsumptionLine(line: string): { purpose: string; quantity: number } | null {
  const parts = line.split("=");
  if (parts.length !== 2) return null;
  const purpose = parts[0].trim();
  const quantityStr = parts[1].trim();
  const quantity = parseFloat(quantityStr);
  if (!purpose || isNaN(quantity) || quantity < 0) return null;
  return { purpose, quantity };
}

function mergeProductionEntries(existing: any[] = [], newEntries: any[]): any[] {
  const merged = [...existing];
  for (const entry of newEntries) {
    const idx = merged.findIndex(e => e.cow_name.toLowerCase() === entry.cow_name.toLowerCase());
    if (idx > -1) {
      merged[idx] = { ...merged[idx], ...entry };
    } else {
      merged.push(entry);
    }
  }
  return merged;
}

function mergeConsumptionEntries(existing: any[] = [], newEntries: any[]): any[] {
  const merged = [...existing];
  for (const entry of newEntries) {
    const idx = merged.findIndex(e => e.purpose.toLowerCase() === entry.purpose.toLowerCase());
    if (idx > -1) {
      merged[idx] = { ...merged[idx], ...entry };
    } else {
      merged.push(entry);
    }
  }
  return merged;
}

// --- In-Memory Mock Database ---

const mockUsers = [
  { id: 1, phone_number: "+919876543210", userName: "Ramesh", dairy_id: 1, isActive: true }
];

let livestockRows = [
  { id: 101, name: "Gauri", num: "Gauri", dairy_id: 1 },
  { id: 102, name: "Laxmi", num: "Laxmi", dairy_id: 1 }
];

let productionRows: any[] = [];
let utilizationRows: any[] = [];
let sessionStore = new Map<string, Session>();
let preferencesStore = new Map<string, UserPreferences>();

function resetMockDb() {
  productionRows = [];
  utilizationRows = [];
  livestockRows = [
    { id: 101, name: "Gauri", num: "Gauri", dairy_id: 1 },
    { id: 102, name: "Laxmi", num: "Laxmi", dairy_id: 1 }
  ];
  sessionStore.clear();
  preferencesStore.clear();
}

// --- Local Implementations of Handlers ---

class AuthenticateUserHandler implements IActionHandler {
  public async execute(ctx: ExecutionContext): Promise<ActionResponse> {
    const matched = mockUsers.find(u => u.phone_number === ctx.phone_number && u.isActive);
    if (matched) {
      return {
        transition: "authorized",
        updatedData: {
          userName: matched.userName,
          dairy_id: matched.dairy_id
        }
      };
    }
    return { transition: "unauthorized" };
  }
}

class SetLanguageHandler implements IActionHandler {
  public async execute(ctx: ExecutionContext, params?: any): Promise<ActionResponse> {
    return { transition: "default", updatedData: { language: params?.lang || "en" } };
  }
}

class SetTodayDateProductionHandler implements IActionHandler {
  public async execute(ctx: ExecutionContext): Promise<ActionResponse> {
    return { transition: "default", updatedData: { entry_date: getIstDateString(0) } };
  }
}

class SetYesterdayDateProductionHandler implements IActionHandler {
  public async execute(ctx: ExecutionContext): Promise<ActionResponse> {
    return { transition: "default", updatedData: { entry_date: getIstDateString(-1) } };
  }
}

class ValidateAndSetDateProductionHandler implements IActionHandler {
  public async execute(ctx: ExecutionContext): Promise<ActionResponse> {
    const input = ctx.user_input;
    if (!input) return { transition: "invalid" };
    const valid = validateDate(input);
    if (valid) return { transition: "valid", updatedData: { entry_date: valid } };
    return { transition: "invalid" };
  }
}

class ParseMilkProductionEntriesHandler implements IActionHandler {
  public async execute(ctx: ExecutionContext): Promise<ActionResponse> {
    const input = ctx.user_input;
    if (!input) return { transition: "invalid" };

    const lines = input.split("\n").map(l => l.trim()).filter(l => l.length > 0);
    const parsedEntries: any[] = [];
    for (const line of lines) {
      const parsed = parseProductionLine(line);
      if (!parsed) return { transition: "invalid" };
      parsedEntries.push(parsed);
    }
    const current = ctx.session_data.milk_entries || [];
    return { transition: "valid", updatedData: { milk_entries: mergeProductionEntries(current, parsedEntries) } };
  }
}

class DisplayProductionSummaryHandler implements IActionHandler {
  public async execute(ctx: ExecutionContext): Promise<ActionResponse> {
    const entries = ctx.session_data.milk_entries || [];
    const date = ctx.session_data.entry_date || getIstDateString(0);
    const lang = ctx.language;

    let body = (lang === "mr" ? `${date} चे नोंदी तपासा:` : `Please review your entries for ${date}:`) + "\n\n";
    if (entries.length === 0) {
      body += (lang === "mr" ? "कोणतीही नोंद आढळली नाही." : "No entries recorded.");
    } else {
      entries.forEach((e: any, idx: number) => {
        if (lang === "mr") {
          body += `${idx + 1}. ${e.cow_name} — सकाळ: ${e.morning}L, संध्याकाळ: ${e.evening}L\n`;
        } else {
          body += `${idx + 1}. ${e.cow_name} — Morning: ${e.morning}L, Evening: ${e.evening}L\n`;
        }
      });
    }

    ctx.addMessage({ type: "text", text: { body: body.trim() } });
    return { transition: "default" };
  }
}

class ParseAndUpdateProductionEntriesHandler implements IActionHandler {
  public async execute(ctx: ExecutionContext): Promise<ActionResponse> {
    const input = ctx.user_input;
    if (!input) return { transition: "invalid" };

    const lines = input.split("\n").map(l => l.trim()).filter(l => l.length > 0);
    const parsedEntries: any[] = [];
    for (const line of lines) {
      const parsed = parseProductionLine(line);
      if (!parsed) return { transition: "invalid" };
      parsedEntries.push(parsed);
    }
    const current = ctx.session_data.milk_entries || [];
    return { transition: "valid", updatedData: { milk_entries: mergeProductionEntries(current, parsedEntries) } };
  }
}

class SubmitProductionToBackendHandler implements IActionHandler {
  public async execute(ctx: ExecutionContext): Promise<ActionResponse> {
    const entries = ctx.session_data.milk_entries || [];
    const entryDateStr = ctx.session_data.entry_date;
    const dairyId = ctx.session_data.dairy_id;

    if (!entryDateStr || !dairyId || entries.length === 0) {
      return { transition: "failure" };
    }

    for (const entry of entries) {
      let cow = livestockRows.find(c => c.name.toLowerCase() === entry.cow_name.toLowerCase() && c.dairy_id === dairyId);
      if (!cow) {
        cow = { id: livestockRows.length + 101, name: entry.cow_name, num: entry.cow_name, dairy_id: dairyId };
        livestockRows.push(cow);
      }
      productionRows.push({
        cowid: cow.id,
        productionDate: entryDateStr,
        morning: String(entry.morning),
        evening: String(entry.evening),
        milkType: "White"
      });
    }
    return { transition: "success" };
  }
}

class SetTodayDateConsumptionHandler implements IActionHandler {
  public async execute(ctx: ExecutionContext): Promise<ActionResponse> {
    return { transition: "default", updatedData: { entry_date: getIstDateString(0) } };
  }
}

class SetYesterdayDateConsumptionHandler implements IActionHandler {
  public async execute(ctx: ExecutionContext): Promise<ActionResponse> {
    return { transition: "default", updatedData: { entry_date: getIstDateString(-1) } };
  }
}

class ValidateAndSetDateConsumptionHandler implements IActionHandler {
  public async execute(ctx: ExecutionContext): Promise<ActionResponse> {
    const input = ctx.user_input;
    if (!input) return { transition: "invalid" };
    const valid = validateDate(input);
    if (valid) return { transition: "valid", updatedData: { entry_date: valid } };
    return { transition: "invalid" };
  }
}

class ParseMilkConsumptionEntriesHandler implements IActionHandler {
  public async execute(ctx: ExecutionContext): Promise<ActionResponse> {
    const input = ctx.user_input;
    if (!input) return { transition: "invalid" };

    const lines = input.split("\n").map(l => l.trim()).filter(l => l.length > 0);
    const parsedEntries: any[] = [];
    for (const line of lines) {
      const parsed = parseConsumptionLine(line);
      if (!parsed) return { transition: "invalid" };
      parsedEntries.push(parsed);
    }
    const current = ctx.session_data.consumption_entries || [];
    return { transition: "valid", updatedData: { consumption_entries: mergeConsumptionEntries(current, parsedEntries) } };
  }
}

class DisplayConsumptionSummaryHandler implements IActionHandler {
  public async execute(ctx: ExecutionContext): Promise<ActionResponse> {
    const entries = ctx.session_data.consumption_entries || [];
    const date = ctx.session_data.entry_date || getIstDateString(0);
    const lang = ctx.language;

    let body = (lang === "mr" ? `${date} चे वापर नोंदी तपासा:` : `Please review your consumption entries for ${date}:`) + "\n\n";
    if (entries.length === 0) {
      body += (lang === "mr" ? "कोणतीही नोंद आढळली नाही." : "No entries recorded.");
    } else {
      entries.forEach((e: any, idx: number) => {
        if (lang === "mr") {
          body += `${idx + 1}. ${e.purpose} — ${e.quantity}L\n`;
        } else {
          body += `${idx + 1}. ${e.purpose} — ${e.quantity}L\n`;
        }
      });
    }

    ctx.addMessage({ type: "text", text: { body: body.trim() } });
    return { transition: "default" };
  }
}

class ParseAndUpdateConsumptionEntriesHandler implements IActionHandler {
  public async execute(ctx: ExecutionContext): Promise<ActionResponse> {
    const input = ctx.user_input;
    if (!input) return { transition: "invalid" };

    const lines = input.split("\n").map(l => l.trim()).filter(l => l.length > 0);
    const parsedEntries: any[] = [];
    for (const line of lines) {
      const parsed = parseConsumptionLine(line);
      if (!parsed) return { transition: "invalid" };
      parsedEntries.push(parsed);
    }
    const current = ctx.session_data.consumption_entries || [];
    return { transition: "valid", updatedData: { consumption_entries: mergeConsumptionEntries(current, parsedEntries) } };
  }
}

class SubmitConsumptionToBackendHandler implements IActionHandler {
  public async execute(ctx: ExecutionContext): Promise<ActionResponse> {
    const entries = ctx.session_data.consumption_entries || [];
    const entryDateStr = ctx.session_data.entry_date;
    const dairyId = ctx.session_data.dairy_id;

    if (!entryDateStr || !dairyId || entries.length === 0) {
      return { transition: "failure" };
    }

    for (const entry of entries) {
      utilizationRows.push({
        date: entryDateStr,
        milkPurpose: entry.purpose,
        consumedQuantity: String(entry.quantity),
        dairy_id: dairyId
      });
    }
    return { transition: "success" };
  }
}

// --- Mock Repositories ---

class MockSessionRepository implements ISessionRepository {
  public async get(phone: string): Promise<Session | null> {
    return sessionStore.get(phone) || null;
  }
  public async save(phone: string, session: Session): Promise<void> {
    sessionStore.set(phone, session);
  }
  public async delete(phone: string): Promise<void> {
    sessionStore.delete(phone);
  }
}

class MockUserPreferenceRepository implements IUserPreferenceRepository {
  public async get(phone: string): Promise<UserPreferences | null> {
    return preferencesStore.get(phone) || null;
  }
  public async save(phone: string, preferences: UserPreferences): Promise<void> {
    preferencesStore.set(phone, preferences);
  }
}

class MockTranslationProvider implements ITranslationProvider {
  private dict: Record<string, Record<string, string>> = {
    en: {
      welcomeMessage: "Welcome to Anand Dairy",
      languagePrompt: "Please select language:",
      mainMenuPrompt: "What would you like to do?",
      dateSelectionPrompt: "Select date for milk entry:",
      pastDatePrompt: "Please enter the date in format DD/MM/YYYY",
      milkEntryFormat: "You can now add milk production data...",
      addMorePrompt: "Would you like to add more?",
      confirmEditPrompt: "Please review your entries...",
      editEntryPrompt: "Please re-enter the corrected record(s)",
      submissionSuccess: "Milk production data successfully recorded! Thank you!",
      sessionExpired: "Your session has expired. Please start again.",
      languageInvalid: "Invalid option. Please try again.",
      mainMenuInvalid: "Invalid option. Please try again.",
      dateSelectionInvalid: "Invalid option. Please try again.",
      unauthorizedMessage: "Unauthorized access! Please contact admin!"
    },
    mr: {
      welcomeMessage: "आनंद डेअरीमध्ये आपले स्वागत आहे",
      languagePrompt: "कृपया भाषा निवडा:",
      mainMenuPrompt: "तुम्हाला काय करायचे आहे?",
      dateSelectionPrompt: "दूध नोंदीसाठी तारीख निवडा:",
      pastDatePrompt: "कृपया DD/MM/YYYY स्वरूपात तारीख प्रविष्ट करा",
      milkEntryFormat: "तुम्ही आता दूध उत्पादन डेटा जोडू शकता...",
      addMorePrompt: "तुम्हाला आणखी जोडायचे आहे का?",
      confirmEditPrompt: "कृपया तुमच्या नोंदी तपासा...",
      editEntryPrompt: "कृपया दुरुस्त केलेली नोंद पुन्हा प्रविष्ट करा",
      submissionSuccess: "दूध उत्पादन डेटा यशस्वीरित्या नोंदवला गेला! धन्यवाद!",
      sessionExpired: "तुमचे सत्र कालबाह्य झाले आहे. कृपया पुन्हा सुरू करा.",
      languageInvalid: "Invalid option. Please try again.",
      mainMenuInvalid: "Invalid option. Please try again.",
      dateSelectionInvalid: "Invalid option. Please try again.",
      unauthorizedMessage: "Unauthorized access! Please contact admin!"
    }
  };

  public translate(key: string, locale: string, placeholders?: Record<string, string>): string {
    const lang = locale === "mr" ? "mr" : "en";
    let val = this.dict[lang][key] || key;
    if (placeholders) {
      for (const [k, v] of Object.entries(placeholders)) {
        val = val.replace(`{${k}}`, v);
      }
    }
    return val;
  }
}

describe("WhatsApp Chatbot State Engine Unit Tests", () => {
  let engine: StateEngine;
  let registry: ActionRegistry;
  let sessionRepo: MockSessionRepository;
  let prefRepo: MockUserPreferenceRepository;
  let translationProvider: MockTranslationProvider;
  let uiResolver: UIResolver;

  beforeEach(() => {
    resetMockDb();

    registry = new ActionRegistry();
    registry.register("authenticateUser", new AuthenticateUserHandler());
    registry.register("setLanguage", new SetLanguageHandler());
    registry.register("setTodayDateProduction", new SetTodayDateProductionHandler());
    registry.register("setYesterdayDateProduction", new SetYesterdayDateProductionHandler());
    registry.register("validateAndSetDateProduction", new ValidateAndSetDateProductionHandler());
    registry.register("parseMilkProductionEntries", new ParseMilkProductionEntriesHandler());
    registry.register("displayProductionSummary", new DisplayProductionSummaryHandler());
    registry.register("parseAndUpdateProductionEntries", new ParseAndUpdateProductionEntriesHandler());
    registry.register("submitProductionToBackend", new SubmitProductionToBackendHandler());
    registry.register("setTodayDateConsumption", new SetTodayDateConsumptionHandler());
    registry.register("setYesterdayDateConsumption", new SetYesterdayDateConsumptionHandler());
    registry.register("validateAndSetDateConsumption", new ValidateAndSetDateConsumptionHandler());
    registry.register("parseMilkConsumptionEntries", new ParseMilkConsumptionEntriesHandler());
    registry.register("displayConsumptionSummary", new DisplayConsumptionSummaryHandler());
    registry.register("parseAndUpdateConsumptionEntries", new ParseAndUpdateConsumptionEntriesHandler());
    registry.register("submitConsumptionToBackend", new SubmitConsumptionToBackendHandler());

    sessionRepo = new MockSessionRepository();
    prefRepo = new MockUserPreferenceRepository();
    translationProvider = new MockTranslationProvider();
    uiResolver = new UIResolver({ translationProvider });

    engine = new StateEngine({
      sessionRepository: sessionRepo,
      actionRegistry: registry,
      preferenceRepository: prefRepo,
      uiResolver,
      sessionTtlMs: 10 * 60 * 1000 // 10 mins
    });
  });

  test("1. Unregistered number should terminate at unauthorized state", async () => {
    const phone = "+910000000000"; // Unregistered

    const response = await engine.advance(phone, workflowConfig, "Hi", null);
    
    expect(response.length).toBe(1);
    expect(response[0].type).toBe("text");
    expect(response[0].text.body).toContain("Unauthorized access");

    const session = await sessionRepo.get(phone);
    expect(session).toBeNull();
  });

  test("2. Happy Path - Marathi Language - Today Date - Production Submission", async () => {
    const phone = "+919876543210"; // Ramesh (registered)

    // Step A: Send "Hi" -> welcomes and auto-advances to languageSelection prompt
    let response = await engine.advance(phone, workflowConfig, "Hi", null);
    
    expect(response.length).toBe(2);
    expect(response[0].type).toBe("text");
    expect(response[0].text.body).toBe("Welcome to Anand Dairy");
    expect(response[1].type).toBe("interactive");
    expect(response[1].interactive.type).toBe("button");
    expect(response[1].interactive.body.text).toBe("Please select language:");

    let session = await sessionRepo.get(phone);
    expect(session).not.toBeNull();
    expect(session?.current_state).toBe("languageSelection");

    // Step B: Select Marathi (option 2)
    response = await engine.advance(phone, workflowConfig, "2", null);

    expect(response.length).toBe(1);
    expect(response[0].interactive.body.text).toBe("तुम्हाला काय करायचे आहे?");
    expect(response[0].interactive.action.buttons[0].reply.title).toBe("Add Milk Production");

    session = await sessionRepo.get(phone);
    expect(session?.current_state).toBe("mainMenu");
    expect(session?.language).toBe("mr");

    // Step C: Select Add Milk Production (option 1)
    response = await engine.advance(phone, workflowConfig, "1", null);

    expect(response.length).toBe(1);
    expect(response[0].interactive.body.text).toBe("दूध नोंदीसाठी तारीख निवडा:");

    session = await sessionRepo.get(phone);
    expect(session?.current_state).toBe("dateSelectionProduction");

    // Step D: Select Today (option 1)
    response = await engine.advance(phone, workflowConfig, "1", null);

    expect(response.length).toBe(2);
    expect(response[0].text.body).toContain("तुम्ही आता दूध उत्पादन डेटा जोडू शकता");
    
    session = await sessionRepo.get(phone);
    expect(session?.current_state).toBe("milkEntryInput");
    expect(session?.context_data.entry_date).toBe(getIstDateString(0));

    // Step E: Send cow milk entries
    const inputBlock = "Gauri, M=8, E=6\nLaxmi, Morning Milk=0, Evening Milk=5";
    response = await engine.advance(phone, workflowConfig, inputBlock, null);

    expect(response.length).toBe(1);
    expect(response[0].interactive.body.text).toBe("तुम्हाला आणखी जोडायचे आहे का?");

    session = await sessionRepo.get(phone);
    expect(session?.current_state).toBe("addMoreProductionPrompt");
    expect(session?.context_data.milk_entries.length).toBe(2);

    // Step F: Reply "Done" (option 2)
    response = await engine.advance(phone, workflowConfig, "2", null);

    expect(response.length).toBe(2);
    expect(response[0].text.body).toContain("नोंदी तपासा");
    expect(response[0].text.body).toContain("Gauri — सकाळ: 8L, संध्याकाळ: 6L");
    expect(response[0].text.body).toContain("Laxmi — सकाळ: 0L, संध्याकाळ: 5L");
    expect(response[1].interactive.body.text).toContain("तपासा");

    session = await sessionRepo.get(phone);
    expect(session?.current_state).toBe("confirmOrEditProduction");

    // Step G: Confirm & Submit (option 1)
    response = await engine.advance(phone, workflowConfig, "1", null);

    expect(response.length).toBe(1);
    expect(response[0].text.body).toBe("दूध उत्पादन डेटा यशस्वीरित्या नोंदवला गेला! धन्यवाद!");

    session = await sessionRepo.get(phone);
    expect(session).toBeNull(); // deleted

    // Verify mock database table has correct records
    expect(productionRows.length).toBe(2);
    expect(productionRows[0].cowid).toBe(101); // Gauri
    expect(productionRows[0].morning).toBe("8");
    expect(productionRows[0].evening).toBe("6");
    expect(productionRows[1].cowid).toBe(102); // Laxmi
    expect(productionRows[1].morning).toBe("0");
    expect(productionRows[1].evening).toBe("5");
  });

  test("3. Edit Loop - Modify milk entry quantity before confirming", async () => {
    const phone = "+919876543210";
    
    const initialSession: Session = {
      phone_number: phone,
      current_state: "confirmOrEditProduction",
      language: "en",
      context_data: {
        dairy_id: 1,
        entry_date: getIstDateString(0),
        milk_entries: [
          { cow_name: "Gauri", morning: 8, evening: 6 },
          { cow_name: "Laxmi", morning: 0, evening: 5 }
        ]
      },
      created_at: new Date(),
      updated_at: new Date()
    };
    await sessionRepo.save(phone, initialSession);

    // Select "Edit" (Option 2)
    let response = await engine.advance(phone, workflowConfig, "2", null);

    expect(response.length).toBe(1);
    expect(response[0].text.body).toBe("Please re-enter the corrected record(s)");

    let session = await sessionRepo.get(phone);
    expect(session?.current_state).toBe("editProductionEntry");

    // Submit correction for Gauri (morning increased to 10)
    response = await engine.advance(phone, workflowConfig, "Gauri, M=10, E=6", null);

    expect(response.length).toBe(2);
    expect(response[0].text.body).toContain("Gauri — Morning: 10L, Evening: 6L"); // updated
    expect(response[0].text.body).toContain("Laxmi — Morning: 0L, Evening: 5L"); // unchanged

    session = await sessionRepo.get(phone);
    expect(session?.current_state).toBe("confirmOrEditProduction");
    expect(session?.context_data.milk_entries.length).toBe(2);
    expect(session?.context_data.milk_entries[0].morning).toBe(10);
  });

  test("4. Session Timeout - resets active session and shows warning", async () => {
    const phone = "+919876543210";

    const expiredTime = new Date(Date.now() - 11 * 60 * 1000);
    const expiredSession: Session = {
      phone_number: phone,
      current_state: "confirmOrEditProduction",
      language: "en",
      context_data: {
        dairy_id: 1,
        entry_date: getIstDateString(0),
        milk_entries: [{ cow_name: "Gauri", morning: 8, evening: 6 }]
      },
      created_at: expiredTime,
      updated_at: expiredTime
    };
    await sessionRepo.save(phone, expiredSession);

    const response = await engine.advance(phone, workflowConfig, "Hi", null);

    expect(response.length).toBe(3);
    expect(response[0].text.body).toBe("Your session has expired. Please start again.");
    expect(response[1].text.body).toBe("Welcome to Anand Dairy");
    expect(response[2].interactive.body.text).toBe("Please select language:");

    const session = await sessionRepo.get(phone);
    expect(session?.current_state).toBe("languageSelection");
    expect(session?.context_data.milk_entries).toBeUndefined();
    expect(session?.context_data.entry_date).toBeUndefined();
    expect(session?.context_data.userName).toBe("Ramesh");
    expect(session?.context_data.dairy_id).toBe(1);
  });

  test("5. Invalid input on prompt - re-prompts user instead of failing", async () => {
    const phone = "+919876543210";
    const session: Session = {
      phone_number: phone,
      current_state: "languageSelection",
      language: "en",
      context_data: {},
      created_at: new Date(),
      updated_at: new Date()
    };
    await sessionRepo.save(phone, session);

    const response = await engine.advance(phone, workflowConfig, "Hello", null);

    expect(response.length).toBe(2);
    expect(response[0].text.body).toBe("Invalid option. Please try again.");
    expect(response[1].interactive.body.text).toBe("Please select language:");

    const currentSession = await sessionRepo.get(phone);
    expect(currentSession?.current_state).toBe("languageSelection");
  });
});
