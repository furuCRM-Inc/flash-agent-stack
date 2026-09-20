/**
 * inject.ts — runs in MAIN world (page context).
 * Creates window.modelContext so any web app (LWC, React, vanilla JS)
 * can register tools via the WebMCP protocol.
 */

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema?: object;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
}

interface ModelContext {
  registerTool(def: ToolDefinition): void;
  listTools(): { name: string; description: string; inputSchema?: object }[];
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

const _tools = new Map<string, ToolDefinition>();

const modelContext: ModelContext = {
  registerTool(def: ToolDefinition) {
    _tools.set(def.name, def);

    // Notify the content script that a new tool was registered
    window.postMessage(
      {
        __flashAgent: true,
        type: 'TOOL_REGISTERED',
        payload: { name: def.name, description: def.description, inputSchema: def.inputSchema },
      },
      '*'
    );
  },

  listTools() {
    return [..._tools.values()].map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
    }));
  },

  async callTool(name: string, args: Record<string, unknown>) {
    const tool = _tools.get(name);
    if (!tool) throw new Error(`Tool not registered: ${name}`);
    return tool.execute(args);
  },
};

// Expose as both document.modelContext (WebMCP spec) and window.modelContext
Object.defineProperty(document, 'modelContext', {
  value: modelContext,
  writable: false,
  configurable: false,
});

(window as unknown as Record<string, unknown>).modelContext = modelContext;

// Listen for CALL_TOOL messages from content script (forwarded from background)
window.addEventListener('message', async (event) => {
  if (!event.data?.__flashAgent) return;

  if (event.data.type === 'CALL_TOOL') {
    const { callId, toolName, args } = event.data.payload as {
      callId: string;
      toolName: string;
      args: Record<string, unknown>;
    };

    try {
      const result = await modelContext.callTool(toolName, args);
      window.postMessage(
        {
          __flashAgent: true,
          type: 'TOOL_RESULT',
          payload: { callId, result, error: null },
        },
        '*'
      );
    } catch (err) {
      window.postMessage(
        {
          __flashAgent: true,
          type: 'TOOL_RESULT',
          payload: { callId, result: null, error: String(err) },
        },
        '*'
      );
    }
  }
});

console.debug('[FlashAgent] window.modelContext installed.');
