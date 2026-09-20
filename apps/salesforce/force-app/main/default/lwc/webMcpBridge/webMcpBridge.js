import { LightningElement, api } from 'lwc';
import generateResolution from '@salesforce/apex/JevReflexController.generateResolution';

/**
 * WebMCP Bridge — registers Salesforce actions as AI-callable tools
 * via the document.modelContext protocol.
 *
 * Usage: include <c-web-mcp-bridge> inside your LWC template.
 * Listen for 'toolregistered' events on the parent to track registration.
 * The parent calls bridge.callTool() via the @api method.
 */
export default class WebMcpBridge extends LightningElement {

    _registeredTools = [];

    renderedCallback() {
        if (this._registeredTools.length > 0) return; // already registered
        this._registerAll();
    }

    disconnectedCallback() {
        // No cleanup needed — modelContext lives for the browser session
    }

    _registerAll() {
        if (!document.modelContext) {
            // Install a minimal stub if the Chrome extension is not present
            this._installStub();
        }

        this._register({
            name: 'approve_refund',
            description: 'Approves an immediate VIP retention refund and creates a transaction record.',
            inputSchema: {
                type: 'object',
                properties: {
                    amount:    { type: 'number', description: 'Refund amount in USD' },
                    caseId:    { type: 'string', description: 'Salesforce Case ID' },
                    reason:    { type: 'string', description: 'Refund reason (optional)' }
                },
                required: ['amount', 'caseId']
            },
            execute: async ({ amount, caseId, reason }) => {
                const txnId = 'REF-' + Date.now().toString().slice(-8);
                return { success: true, transactionId: txnId, amount, caseId, reason, processedAt: new Date().toISOString() };
            }
        });

        this._register({
            name: 'reroute_case',
            description: 'Routes a case to the VIP Retention Tier-3 queue with Critical priority.',
            inputSchema: {
                type: 'object',
                properties: {
                    caseId:   { type: 'string', description: 'Salesforce Case ID' },
                    priority: { type: 'string', enum: ['Critical', 'High', 'Medium'] }
                },
                required: ['caseId']
            },
            execute: async ({ caseId, priority = 'Critical' }) => ({
                success: true,
                assignedTo: 'VIP Retention Team',
                priority,
                slaMinutes: 15,
                caseId
            })
        });

        this._register({
            name: 'generate_resolution_message',
            description: 'Generates a personalised customer resolution message via Apex.',
            inputSchema: {
                type: 'object',
                properties: {
                    customerName:  { type: 'string' },
                    refundAmount:  { type: 'number' }
                },
                required: ['customerName', 'refundAmount']
            },
            execute: async ({ customerName, refundAmount }) =>
                generateResolution({ customerName, refundAmount })
        });
    }

    _register(def) {
        document.modelContext.registerTool(def);
        this._registeredTools.push(def.name);
        this.dispatchEvent(new CustomEvent('toolregistered', { detail: { name: def.name }, bubbles: true }));
    }

    _installStub() {
        const _tools = new Map();
        document.modelContext = {
            registerTool(def) { _tools.set(def.name, def); },
            listTools() { return [..._tools.values()].map(({ name, description }) => ({ name, description })); },
            async callTool(name, args) {
                const tool = _tools.get(name);
                if (!tool) throw new Error(`Tool not registered: ${name}`);
                return tool.execute(args);
            }
        };
    }

    /** Expose callTool to parent component via public method */
    @api
    async callTool(name, args) {
        return document.modelContext.callTool(name, args);
    }

    /** Returns registered tool names */
    @api
    get registeredToolNames() {
        return [...this._registeredTools];
    }
}
