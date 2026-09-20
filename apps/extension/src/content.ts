/**
 * content.ts — runs in MAIN world alongside inject.ts.
 * Bridges window.postMessage (page ↔ content) and chrome.runtime.sendMessage (content ↔ background).
 *
 * Message flow:
 *   Page (inject.ts) ──postMessage──▶ content.ts ──runtime.sendMessage──▶ background.ts
 *   background.ts ──runtime.sendMessage──▶ content.ts ──postMessage──▶ Page (inject.ts)
 */

// Page → background: relay tool registrations and results
window.addEventListener('message', (event) => {
  if (!event.data?.__flashAgent) return;

  const { type, payload } = event.data as { type: string; payload: unknown };

  if (type === 'TOOL_REGISTERED' || type === 'TOOL_RESULT') {
    chrome.runtime.sendMessage({ __flashAgent: true, type, payload });
  }
});

// Background → page: relay CALL_TOOL requests
chrome.runtime.onMessage.addListener((message) => {
  if (!message?.__flashAgent) return;

  if (message.type === 'CALL_TOOL') {
    window.postMessage({ __flashAgent: true, type: 'CALL_TOOL', payload: message.payload }, '*');
  }
});
