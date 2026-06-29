# Layer 1 Technical Specification — Engine Core & Ports Definition

This document defines the interface specifications, internal components, and runtime algorithms for the domain-agnostic **Engine Core & Ports** layer (Layer 1). This layer is designed to run in complete isolation from the database implementation and specific business logic domains.

---

## 1. Interface Specifications & Ports (`src/core/interfaces.ts`)

Ports establish abstract boundaries that separate the state machine's execution loop from external dependencies.

### Session Entity Interface
Represents the structural model of the active user session state:
```typescript
export interface Session {
  phone_number: string;
  current_state: string;
  language: string;
  context_data: Record<string, any>; // Arbitrary domain variables collected during the workflow (e.g. dairy_id, entry_date)
  updated_at: Date;
  created_at: Date;
}
```

### Persistence Port (`ISessionRepository`)
The repository abstraction that handles state persistence. The engine core executes operations strictly through this contract:
```typescript
export interface ISessionRepository {
  get(phone: string): Promise<Session | null>;
  save(phone: string, session: Session): Promise<void>;
  delete(phone: string): Promise<void>;
}
```

### Business Logic Port (`IActionHandler`)
The contract implemented by pluggable business domain action modules. Handlers return standard transition results back to the engine:
```typescript
export interface ActionResponse {
  transition: string;                // The resulting edge to traverse in the graph (e.g., "success", "invalid")
  updatedData?: Record<string, any>;  // Optional domain variables to merge into session context_data
}

export interface IActionHandler {
  execute(ctx: ExecutionContext): Promise<ActionResponse>;
}
```

### Action Registry Port (`IActionRegistry`)
The registry contract used by the engine core to resolve action hooks at runtime:
```typescript
export interface IActionRegistry {
  get(name: string): IActionHandler | null;
  register(name: string, handler: IActionHandler): void;
}
```

---

## 2. Transient Execution Context (`src/core/ExecutionContext.ts`)

The `ExecutionContext` represents a thread-safe, request-scoped context container initialized at the start of a request. It isolates session states, user inputs, and output messages during a single execution pass.

### Class Properties
* `phone_number: string` (The unique identifier of the active user in the communication channel)
* `session_data: Record<string, any>` (The context variables collected during the active session. Tenant-specific identifiers, such as dairy_id or store_id, are stored here dynamically)
* `user_input: string | null` (The raw text value submitted by the user)
* `button_payload: string | null` (The payload key returned from interactive elements)
* `language: string` (The active locale/language code)
* `messages: Array<any>` (The accumulated list of output message payloads to be sent to the client)

### API Methods
* `updateData(data: Record<string, any>): void`
  * Merges new key-value pairs into `session_data` (shallow merge).
* `addMessage(payload: any): void`
  * Appends a formatted message payload to the output queue.
* `getLanguage(): string`
  * Returns the active locale identifier.

---

## 3. UI Resolver & Schema Transformation (`src/core/UIResolver.ts`)

The `UIResolver` is a structural adapter. It transforms abstract state-rendering definitions from the workflow configuration file into platform-specific message templates, conforming dynamically to Meta Cloud API constraints.

### Adaptive Layout Resolution Flow

```mermaid
graph TD
    Start([UIResolver.resolve]) --> Count{Inspect Option Count}
    
    Count -->|1 to 3 items| LabelCheck{Are all option labels <= 20 chars?}
    Count -->|4 to 10 items| ListMenu[Format as List Menu Dropdown]
    Count -->|Over 10 items| Numbered[Format as Numbered Text Menu]
    
    LabelCheck -->|Yes| QuickReply[Format as Quick Reply Buttons]
    LabelCheck -->|No| ListMenu
```

### WhatsApp API Schema Mappings

* **Quick Reply Payload Structure**: Used when option count is 3 or less and option labels do not exceed 20 characters.
  ```json
  {
    "type": "interactive",
    "interactive": {
      "type": "button",
      "body": { "text": "Body Text" },
      "action": {
        "buttons": [
          { "type": "reply", "reply": { "id": "option_value", "title": "Option Label" } }
        ]
      }
    }
  }
  ```

* **List Message Payload Structure**: Used when option count is between 4 and 10, or when any option label exceeds the 20-character limit.
  ```json
  {
    "type": "interactive",
    "interactive": {
      "type": "list",
      "header": { "type": "text", "text": "Options Menu" },
      "body": { "text": "Body Text" },
      "action": {
        "button": "Select Option",
        "sections": [
          {
            "rows": [
              { "id": "option_value", "title": "Option Label", "description": "" }
            ]
          }
        ]
      }
    }
  }
  ```

---

## 4. State Engine Orchestrator (`src/core/StateEngine.ts`)

The `StateEngine` manages the state traversal logic. It evaluates the incoming user inputs against the transition rules and runs the action execution loop.

### Engine Advancement Lifecycle Flow

```mermaid
flowchart TD
    Start([advanceRequest]) --> GetSession[1. Load Session from Repository]
    GetSession --> GetPrefs[2. Load Preferences from DynamoDB]
    GetPrefs --> CreateContext[3. Instantiate ExecutionContext]
    CreateContext --> ResolveTrigger{4. Trigger Source?}
    
    ResolveTrigger -->|Button Click| UsePayload[Use button_payload]
    ResolveTrigger -->|Free Text| MatchOption{Text matches option?}
    
    MatchOption -->|Yes| UseOption[Use matched option key]
    MatchOption -->|No| UseDefault[Use 'default' trigger]
    
    UsePayload --> ApplyTransition[5. Resolve next_state from Transitions]
    UseOption --> ApplyTransition
    UseDefault --> ApplyTransition
    
    ApplyTransition --> LoopStart{6. Is next_state an Action State?}
    
    LoopStart -->|Yes| ResolveAction[7. Fetch Action Handler Strategy]
    ResolveAction --> ExecAction[8. Execute Action Handler]
    ExecAction --> IncCounter[9. Increment loop counter]
    IncCounter --> LoopGuard{Loop counter > 10?}
    
    LoopGuard -->|Yes| SystemError[Throw Infinite Loop Error]
    LoopGuard -->|No| MergeData[10. Merge updatedData & Transition State]
    MergeData --> LoopStart
    
    LoopStart -->|No| ResolveUI[11. Call UIResolver to format output payload]
    ResolveUI --> SaveSession[12. Persist state & context to repository]
    SaveSession --> End([Return UI Message Payload])
```

### Engine Advancement Lifecycle Sequence

```mermaid
sequenceDiagram
    autonumber
    participant Caller as Caller (Express Route)
    participant Engine as StateEngine
    participant SessionRepo as ISessionRepository
    participant PrefRepo as IUserPreferenceRepository
    participant Context as ExecutionContext
    participant Registry as ActionRegistry
    participant Handler as IActionHandler
    participant UI as UIResolver

    Caller->>Engine: advance(phone, triggerInput)
    
    Engine->>SessionRepo: get(phone)
    SessionRepo-->>Engine: Session | null
    
    Engine->>PrefRepo: get(phone)
    PrefRepo-->>Engine: UserPreferences | null

    Engine->>Context: new ExecutionContext(phone, sessionData, input, buttonPayload, language)
    Context-->>Engine: ctx

    Engine->>Engine: Resolve current state transitions
    
    loop Auto-Advance (Action states)
        Engine->>Registry: get(actionHook)
        Registry-->>Engine: IActionHandler | null
        Engine->>Handler: execute(ctx)
        Handler-->>Engine: ActionResponse (transition, updatedData)
        Engine->>Context: updateData(updatedData)
        Engine->>Engine: Transition to next state
    end

    Engine->>UI: resolve(state, ctx)
    UI-->>Engine: UI message payload
    
    Engine->>Context: addMessage(payload)
    
    Engine->>SessionRepo: save(phone, updatedSession)
    SessionRepo-->>Engine: void
    
    Engine-->>Caller: return ctx.messages
```

### Engine Advancement Lifecycle Algorithm


1. **Session Retrieval**: Queries the injected `ISessionRepository` using the user's phone number. If no session exists, instantiates a default session entity set to the initial state defined in the configuration workflow.
2. **Context Instantiation**: Creates a request-scoped `ExecutionContext` using the active session data, the incoming webhook triggers, and active locale. Any tenant context (like `dairy_id`) resides dynamically within the session's context data.
3. **Trigger Resolution**:
   * If a `button_payload` is present, it is evaluated as the immediate transition trigger.
   * Else if `user_input` is present, the engine checks if the text matches any option values defined in the current state configuration. If no match is found, it falls back to the `"default"` transition trigger.
4. **Transition Execution**: Resolves the target state key (`next_state`) from the current state's transitions using the trigger value.
5. **Action Execution Loop (Auto-Advance)**:
   * Inspects the target state configuration block.
   * If the state's `type` is `"action"`:
     * Resolves the handler strategy using `IActionRegistry.get(state.actionHook)`.
     * If a matching strategy is registered, invokes `await handler.execute(ctx)`.
     * Merges any returned `updatedData` values into the execution context.
     * Transitions the engine state using the returned transition key (`transitions[actionResponse.transition]`).
     * **Infinite Loop Guard**: Increment a loop execution counter. If the transition loop traverses more than 10 consecutive action states in a single webhook request, break the loop and transition to the system error state to prevent thread exhaustion.
   * If the state's `type` is not `"action"` (e.g., `"prompt"` or `"render"`), the engine exits the auto-advance loop.
6. **Payload Packaging**: Calls the `UIResolver` to transform the final state configuration and context data into the target platform response format, updates the session's active state, and saves the session via the persistence port.
