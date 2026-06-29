# WhatsApp Chatbot State Engine

A domain-agnostic, configuration-driven state machine interpreter loop designed to run conversational workflows for WhatsApp chatbots.

## Installation

```bash
npm install whatsapp-chatbot-state-engine
```

## Development Setup

To set up the project locally for development:

1. **Clone the repository**:
   ```bash
   git clone git@github.com:tdlsoft/whatsappbot-state-engine.git
   cd whatsappbot-state-engine
   ```

2. **Install dependencies**:
   Ensure you have [Node.js](https://nodejs.org/) installed (version 18 or above recommended).
   ```bash
   npm install
   ```

3. **Build the project**:
   Compile TypeScript source files into JavaScript.
   ```bash
   npm run build
   ```

4. **Run Tests**:
   Verify everything is working correctly using the Jest test suite.
   ```bash
   npm run test
   ```

## Features

- **Configuration-Driven**: Conversation paths and message structures are defined in a JSON graph, keeping conversational flows decoupled from the code.
- **Port-Based Design**: Decouples the engine core from databases, user preferences, and translation providers through abstract interfaces.
- **Interactive UI Handling**: Formats text, quick replies, list menus, and text dropdown structures under Meta API constraints.
- **State Flow Management**: Manages auto-advance states, validations, error re-prompting, and inactivity timeouts.

## Commands

- **Build**: Compiles the source TypeScript files to the distributable package.
  ```bash
  npm run build
  ```
- **Test**: Runs the mock unit test suite.
  ```bash
  npm run test
  ```
