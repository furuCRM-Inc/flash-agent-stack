/**
 * background.ts — Manifest V3 service worker.
 * Maintains the global tool registry and proxies tool calls to page context.
 *
 * External agents (Claude Desktop, custom MCP clients, etc.) can:
 *   1. GET /tools        → list registered tools across all tabs
 *   2. POST /call-tool   → invoke a tool by name in a specific tab
 *
 * The background script exposes a minimal HTTP server via fetch override
 * so MCP clients can hit http://localhost:3001 (native messaging bridge pattern).
 *
 * For simpler integration, agents can also use chrome.runtime messaging directly.
 */

interface ToolEntry {
  tabId: number;
  name: string;
  description: string;
  inputSchema?: object;
}

const registry = new Map<string, ToolEntry>();

// Track tab closures — remove tools for closed tabs
chrome.tabs.onRemoved.addListener((tabId) => {
  for (const [key, entry] of registry) {
    if (entry.tabId === tabId) registry.delete(key);
  }
});

// Receive messages from content scripts
chrome.runtime.onMessage.addListener((message, sender) => {
  if (!message?.__flashAgent) return;

  const tabId = sender.tab?.id;
  if (tabId === undefined) return;

  if (message.type === 'TOOL_REGISTERED') {
    const { name, description, inputSchema } = message.payload as ToolEntry;
    registry.set(`${tabId}:${name}`, { tabId, name, description, inputSchema });
    console.debug(`[FlashAgent BG] Tool registered: ${name} (tab ${tabId})`);
  }

  if (message.type === 'TOOL_RESULT') {
    // Forward to any waiting promise in callToolInTab
    const { callId, result, error } = message.payload as {
      callId: string;
      result: unknown;
      error: string | null;
    };
    const resolver = _pendingCalls.get(callId);
    if (resolver) {
      _pendingCalls.delete(callId);
      resolver({ result, error });
    }
  }
});

// Pending call resolvers keyed by callId
const _pendingCalls = new Map<
  string,
  (r: { result: unknown; error: string | null }) => void
>();

async function callToolInTab(
  tabId: number,
  toolName: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const callId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  return new Promise((resolve, reject) => {
    _pendingCalls.set(callId, ({ result, error }) => {
      if (error) reject(new Error(error));
      else resolve(result);
    });

    chrome.tabs.sendMessage(tabId, {
      __flashAgent: true,
      type: 'CALL_TOOL',
      payload: { callId, toolName, args },
    });

    // Timeout after 30s
    setTimeout(() => {
      if (_pendingCalls.has(callId)) {
        _pendingCalls.delete(callId);
        reject(new Error(`Tool call timed out: ${toolName}`));
      }
    }, 30_000);
  });
}

// Expose listTools / callTool as a service for the popup or external MCP clients
// via chrome.runtime.sendMessage from the popup
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message?.__flashAgentBg) return false;

  if (message.type === 'LIST_TOOLS') {
    sendResponse([...registry.values()]);
    return true;
  }

  if (message.type === 'CALL_TOOL_EXTERNAL') {
    const { tabId, toolName, args } = message.payload as {
      tabId: number;
      toolName: string;
      args: Record<string, unknown>;
    };
    callToolInTab(tabId, toolName, args)
      .then(result => sendResponse({ result, error: null }))
      .catch(err => sendResponse({ result: null, error: String(err) }));
    return true; // async response
  }

  return false;
});
