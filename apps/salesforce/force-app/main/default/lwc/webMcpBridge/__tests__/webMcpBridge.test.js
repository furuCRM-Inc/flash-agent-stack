import { createElement } from 'lwc';
import WebMcpBridge from 'c/webMcpBridge';
import generateResolution from '@salesforce/apex/JevReflexController.generateResolution';

// ── Helpers ──────────────────────────────────────────────────────────────────

function createBridge() {
    const el = createElement('c-web-mcp-bridge', { is: WebMcpBridge });
    document.body.appendChild(el);
    return el;
}

function removeBridge(el) {
    document.body.removeChild(el);
}

// ── Setup / teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
    delete document.modelContext;
    generateResolution.mockReset();
});

afterEach(() => {
    while (document.body.firstChild) {
        document.body.removeChild(document.body.firstChild);
    }
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('WebMcpBridge — stub installation', () => {
    it('installs document.modelContext when Chrome extension absent', () => {
        expect(document.modelContext).toBeUndefined();
        const el = createBridge();
        return Promise.resolve().then(() => {
            expect(document.modelContext).toBeDefined();
            removeBridge(el);
        });
    });

    it('does not overwrite an existing document.modelContext', () => {
        const sentinel = { registerTool: jest.fn(), listTools: jest.fn(), callTool: jest.fn() };
        document.modelContext = sentinel;
        const el = createBridge();
        return Promise.resolve().then(() => {
            expect(document.modelContext).toBe(sentinel);
            removeBridge(el);
        });
    });
});

describe('WebMcpBridge — tool registration', () => {
    it('registers exactly 3 tools', () => {
        const el = createBridge();
        return Promise.resolve().then(() => {
            expect(el.registeredToolNames).toHaveLength(3);
            removeBridge(el);
        });
    });

    it('registers approve_refund, reroute_case, generate_resolution_message', () => {
        const el = createBridge();
        return Promise.resolve().then(() => {
            expect(el.registeredToolNames).toEqual(
                expect.arrayContaining(['approve_refund', 'reroute_case', 'generate_resolution_message'])
            );
            removeBridge(el);
        });
    });

    it('dispatches toolregistered event for each tool', () => {
        const events = [];
        // Listener must be on the parent (bubbles:true) and attached before DOM insert
        const handler = (e) => events.push(e.detail.name);
        document.body.addEventListener('toolregistered', handler);
        const el = createBridge();
        return Promise.resolve().then(() => {
            document.body.removeEventListener('toolregistered', handler);
            expect(events).toHaveLength(3);
            removeBridge(el);
        });
    });

    it('does not re-register tools on subsequent renders', () => {
        const el = createBridge();
        return Promise.resolve().then(() => {
            const firstCount = el.registeredToolNames.length;
            // Force another render cycle
            return Promise.resolve().then(() => {
                expect(el.registeredToolNames).toHaveLength(firstCount);
                removeBridge(el);
            });
        });
    });
});

describe('WebMcpBridge — callTool (stub)', () => {
    it('approve_refund returns success with transactionId', async () => {
        const el = createBridge();
        await Promise.resolve();
        const result = await el.callTool('approve_refund', { amount: 500, caseId: 'CASE-001' });
        expect(result.success).toBe(true);
        expect(result.transactionId).toMatch(/^REF-/);
        expect(result.amount).toBe(500);
        expect(result.caseId).toBe('CASE-001');
        removeBridge(el);
    });

    it('reroute_case returns VIP Retention Team with Critical priority by default', async () => {
        const el = createBridge();
        await Promise.resolve();
        const result = await el.callTool('reroute_case', { caseId: 'CASE-002' });
        expect(result.success).toBe(true);
        expect(result.assignedTo).toBe('VIP Retention Team');
        expect(result.priority).toBe('Critical');
        expect(result.slaMinutes).toBe(15);
        removeBridge(el);
    });

    it('reroute_case respects explicit priority', async () => {
        const el = createBridge();
        await Promise.resolve();
        const result = await el.callTool('reroute_case', { caseId: 'CASE-003', priority: 'High' });
        expect(result.priority).toBe('High');
        removeBridge(el);
    });

    it('generate_resolution_message delegates to Apex', async () => {
        generateResolution.mockResolvedValue('Dear VIP, refund approved for $50000.');
        const el = createBridge();
        await Promise.resolve();
        const result = await el.callTool('generate_resolution_message', {
            customerName: 'VIP',
            refundAmount: 50000
        });
        expect(generateResolution).toHaveBeenCalledWith({ customerName: 'VIP', refundAmount: 50000 });
        expect(result).toContain('refund approved');
        removeBridge(el);
    });

    it('throws when calling an unregistered tool', async () => {
        const el = createBridge();
        await Promise.resolve();
        await expect(el.callTool('nonexistent_tool', {})).rejects.toThrow('Tool not registered: nonexistent_tool');
        removeBridge(el);
    });
});

describe('WebMcpBridge — stub listTools', () => {
    it('listTools returns name and description for each registered tool', () => {
        const el = createBridge();
        return Promise.resolve().then(() => {
            const tools = document.modelContext.listTools();
            expect(tools).toHaveLength(3);
            tools.forEach(t => {
                expect(t.name).toBeDefined();
                expect(t.description).toBeDefined();
            });
            removeBridge(el);
        });
    });
});
