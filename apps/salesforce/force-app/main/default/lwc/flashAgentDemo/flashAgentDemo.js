import { LightningElement, track } from 'lwc';
import WORKER_URL    from '@salesforce/resourceUrl/flashAgentWorker';
import evaluate      from '@salesforce/apex/JevReflexController.evaluate';
import generateResolution from '@salesforce/apex/JevReflexController.generateResolution';

const CUSTOMER_MSG = 'System down. Lost $50,000. Cancel my subscription and refund me NOW!';

const QUESTIONS_JSON = JSON.stringify({
    is_critical: {
        type: 'noul',
        instructions: 'Does this message indicate a critical high-value customer churn risk requiring immediate action?'
    },
    recommended_action: {
        type: 'choice',
        instructions: 'Select the most appropriate retention action for this customer complaint.',
        criteria: {
            APPROVE_MAX_REFUND: 'Approve full refund immediately for VIP retention',
            ESCALATE:           'Escalate to senior support team',
            STANDARD_RESPONSE:  'Route to standard support queue'
        }
    },
    urgency_level: {
        type: 'score',
        instructions: 'Rate the urgency of this customer situation.',
        levels: {
            '0': 'Low: No immediate churn risk',
            '1': 'Medium: Same-day response needed',
            '2': 'High: Priority response within the hour',
            '3': 'Critical: High-value customer threatening immediate cancellation'
        }
    }
});

const STATE_JSON = JSON.stringify({
    message: CUSTOMER_MSG,
    tier: 'Enterprise',
    threat_value: 50000
});

const MODES = { EDGE: 'edge', API: 'api', SIM: 'simulated' };

const mkTools = () => [
    { id: 't1', name: 'approve_refund',             description: 'Process instant VIP retention refund', icon: '💳', cardClass: 'tool-card' },
    { id: 't2', name: 'reroute_case',               description: 'Route to Tier-3 VIP retention queue', icon: '🔀', cardClass: 'tool-card' },
    { id: 't3', name: 'generate_resolution_message', description: 'Compose personalised reassurance',     icon: '✉️', cardClass: 'tool-card' }
];

export default class FlashAgentDemo extends LightningElement {

    @track mode             = MODES.SIM;   // auto-detected
    @track displayedMessage = '';
    @track chatReceived     = false;
    @track decided          = false;
    @track decisionIdle     = true;
    @track isRunning        = false;
    @track isResolved       = false;
    @track resolutionMessage = '';
    @track toolCards         = mkTools();

    // Latency
    @track latencyInference = 0;
    @track latencyWebmcp    = 0;
    @track latencyTotal     = 0;

    // Decision values
    @track noul             = 0;
    @track choiceKey        = '';
    @track choiceConf       = 0;
    @track score            = 0;

    _worker        = null;
    _workerReady   = false;
    _timers        = [];
    _cancelled     = false;
    _logId         = 0;
    _pendingMsgs   = new Map(); // msgId → { resolve, reject }

    // ── Lifecycle ──────────────────────────────────────────────────────────────

    connectedCallback() {
        this._initWorker();
    }

    disconnectedCallback() {
        this._cancelled = true;
        this._timers.forEach(t => clearTimeout(t));
        if (this._worker) this._worker.terminate();
    }

    // ── Auto-detection: try Edge (Web Worker) first ────────────────────────────

    _initWorker() {
        try {
            this._worker = new Worker(WORKER_URL);
            this._worker.onmessage  = (e) => this._onWorkerMsg(e.data);
            this._worker.onerror    = () => { this._workerReady = false; this.mode = MODES.API; };

            // Send INIT with 5s timeout
            this._workerSend('INIT', {})
                .then(() => {
                    this._workerReady = true;
                    this.mode = MODES.EDGE;
                })
                .catch(() => {
                    this._workerReady = false;
                    this.mode = MODES.API;
                });
        } catch {
            this.mode = MODES.API;
        }
    }

    _onWorkerMsg(data) {
        const resolver = this._pendingMsgs.get(data.id);
        if (!resolver) return;

        if (data.type === 'READY' || data.type === 'RESULT') {
            resolver.resolve(data);
            this._pendingMsgs.delete(data.id);
        } else if (data.type === 'ERROR') {
            resolver.reject(new Error(data.error));
            this._pendingMsgs.delete(data.id);
        }
        // LOADING and PROGRESS are informational — don't resolve
    }

    _workerSend(type, payload, timeoutMs = 8000) {
        return new Promise((resolve, reject) => {
            const id = ++this._logId;
            this._pendingMsgs.set(id, { resolve, reject });
            this._worker.postMessage({ type, id, payload });

            const t = setTimeout(() => {
                if (this._pendingMsgs.has(id)) {
                    this._pendingMsgs.delete(id);
                    reject(new Error('Worker timeout'));
                }
            }, timeoutMs);
            this._timers.push(t);
        });
    }

    // ── Getters ────────────────────────────────────────────────────────────────

    get edgeBadgeClass() { return 'mode-badge mode-badge--edge' + (this.mode === MODES.EDGE ? ' mode-badge--active' : ''); }
    get apiBadgeClass()  { return 'mode-badge mode-badge--api'  + (this.mode === MODES.API  ? ' mode-badge--active' : ''); }
    get simBadgeClass()  { return 'mode-badge mode-badge--sim'  + (this.mode === MODES.SIM  ? ' mode-badge--active' : ''); }

    get modeLabel() {
        return this.mode === MODES.EDGE ? '⚡ EDGE' : this.mode === MODES.API ? '🔵 API' : '⚪ SIM';
    }

    get inferenceLabel() {
        return this.mode === MODES.EDGE ? 'NLI in-browser' : this.mode === MODES.API ? 'Apex → Cloud API' : 'Simulated';
    }

    get noulDisplay()   { return `${(this.noul * 100).toFixed(0)}% critical  (confidence: ${(this.noul * 100).toFixed(1)}%)`; }
    get choiceDisplay() { return `${this.choiceKey}  (${(this.choiceConf * 100).toFixed(0)}% confidence)`; }
    get scoreDisplay()  { return `${this.score.toFixed(2)} / 3.0`; }

    get noulBarStyle()   { return `width: ${Math.round(this.noul   * 100)}%`; }
    get choiceBarStyle() { return `width: ${Math.round(this.choiceConf * 100)}%`; }
    get scoreBarStyle()  { return `width: ${Math.round((this.score / 3) * 100)}%`; }

    // ── Tool event from webMcpBridge ───────────────────────────────────────────

    handleToolRegistered() {
        // Tool registered — no UI update needed, bridge handles it
    }

    // ── Demo execution ─────────────────────────────────────────────────────────

    async triggerAgent() {
        if (this.isRunning) return;
        this._cancelled = false;
        this.isRunning  = true;
        this._resetState(false);

        try {
            // Phase 1: Typewriter effect
            await this._type(CUSTOMER_MSG);
            this.chatReceived = true;
            await this._wait(400);

            // Phase 2: Inference (EDGE or API or fallback to SIM)
            const t0 = Date.now();
            let answers;

            if (this._workerReady && this.mode === MODES.EDGE) {
                answers = await this._runEdge();
            } else {
                answers = await this._runApi();
            }

            this.latencyInference = Date.now() - t0;

            // Populate decision UI
            const noulAns   = answers.is_critical;
            const choiceAns = answers.recommended_action;
            const scoreAns  = answers.urgency_level;

            this.noul      = noulAns.noul ?? 0;
            this.choiceKey = choiceAns.choice ?? 'APPROVE_MAX_REFUND';
            this.choiceConf= choiceAns.confidence ?? 0;
            this.score     = scoreAns.score ?? 0;

            this.decided     = true;
            this.decisionIdle = false;
            await this._wait(300);

            // Phase 3: WebMCP tool calls
            const bridge = this.template.querySelector('c-web-mcp-bridge');

            const tWebmcp = Date.now();
            this._setToolState('t1', 'exec');
            await this._wait(80);
            if (bridge) await bridge.callTool('approve_refund', { amount: 50000, caseId: 'VIP-001' });
            this._setToolState('t1', 'done');

            this._setToolState('t2', 'exec');
            await this._wait(60);
            if (bridge) await bridge.callTool('reroute_case', { caseId: 'VIP-001', priority: 'Critical' });
            this._setToolState('t2', 'done');

            this._setToolState('t3', 'exec');
            await this._wait(40);
            const msg = await (bridge
                ? bridge.callTool('generate_resolution_message', { customerName: 'VIP Customer', refundAmount: 50000 })
                : generateResolution({ customerName: 'VIP Customer', refundAmount: 50000 }));
            this._setToolState('t3', 'done');

            this.latencyWebmcp = Date.now() - tWebmcp;
            this.latencyTotal  = this.latencyInference + this.latencyWebmcp;

            // Phase 4: Resolution
            this.resolutionMessage = typeof msg === 'string' ? msg : msg?.toString() ?? '';
            this.isResolved = true;

        } catch (e) {
            if (e?.message !== 'cancelled') {
                console.error('[FlashAgent]', e);
            }
        } finally {
            this.isRunning = false;
        }
    }

    // ── Edge inference via Web Worker ──────────────────────────────────────────

    async _runEdge() {
        try {
            // Three questions evaluated sequentially through the NLI worker
            // (parallel would require 3 worker instances — single worker is simpler)
            const stateObj = JSON.parse(STATE_JSON);
            const stateText = Object.entries(stateObj).map(([k,v]) => `${k}: ${v}`).join('. ');

            const [noulRes, choiceRes, scoreRes] = await Promise.all([
                this._workerSend('CLASSIFY', {
                    text: `Critical VIP churn risk? Context: ${stateText}`,
                    labels: ['critical VIP churn risk requiring immediate action', 'not critical, standard support is fine']
                }, 30000),
                this._workerSend('CLASSIFY', {
                    text: `Best retention action for: ${stateText}`,
                    labels: ['approve full refund immediately for VIP retention', 'escalate to senior support team', 'route to standard support queue']
                }, 30000),
                this._workerSend('CLASSIFY', {
                    text: `Urgency: ${stateText}`,
                    labels: ['no immediate churn risk', 'same-day response needed', 'priority response within the hour', 'critical high-value customer threatening cancellation']
                }, 30000)
            ]);

            const noul = noulRes.result.scores[0];

            // Map NLI winning label back to a choice key.
            // The worker returns labels sorted descending by score, so labels[0] is the winner.
            // We identify it by matching against the original ordered label array.
            const choiceNliLabels = [
                'approve full refund immediately for VIP retention',
                'escalate to senior support team',
                'route to standard support queue'
            ];
            const choiceKeys = ['APPROVE_MAX_REFUND', 'ESCALATE', 'STANDARD_RESPONSE'];
            const winningNliLabel = choiceRes.result.labels[0];
            const winningIdx  = choiceNliLabels.indexOf(winningNliLabel);
            const choice      = choiceKeys[winningIdx >= 0 ? winningIdx : 0];
            const choiceConf  = choiceRes.result.scores[0];

            const scoreLabels = scoreRes.result.labels;
            const scoreWeighted = scoreLabels.reduce((acc, lbl, i) => {
                const levelIdx = ['no immediate', 'same-day', 'priority response', 'critical'].findIndex(s => lbl.startsWith(s));
                return acc + (levelIdx >= 0 ? levelIdx : i) * scoreRes.result.scores[i];
            }, 0);

            return {
                is_critical:        { noul },
                recommended_action: { choice: choice ?? 'APPROVE_MAX_REFUND', confidence: choiceConf },
                urgency_level:      { score: Math.min(3, scoreWeighted), confidence: scoreRes.result.scores[0] }
            };
        } catch {
            // Worker inference failed — fall through to API
            this.mode = MODES.API;
            return this._runApi();
        }
    }

    // ── API inference via Apex callout ─────────────────────────────────────────

    async _runApi() {
        try {
            const result = await evaluate({ stateJson: STATE_JSON, questionsJson: QUESTIONS_JSON });
            this.mode = result.source === 'simulated' ? MODES.SIM : MODES.API;
            return result.answers;
        } catch {
            this.mode = MODES.SIM;
            return this._simulatedAnswers();
        }
    }

    _simulatedAnswers() {
        return {
            is_critical:        { noul: 0.97 },
            recommended_action: { choice: 'APPROVE_MAX_REFUND', confidence: 0.95 },
            urgency_level:      { score: 2.85, confidence: 0.92 }
        };
    }

    // ── Helpers ────────────────────────────────────────────────────────────────

    resetDemo() {
        this._cancelled = true;
        this._timers.forEach(t => clearTimeout(t));
        this._timers = [];
        setTimeout(() => { this._cancelled = false; this._resetState(true); }, 60);
    }

    _resetState(resetRunning) {
        this.displayedMessage  = '';
        this.chatReceived      = false;
        this.decided           = false;
        this.decisionIdle      = true;
        this.isResolved        = false;
        this.resolutionMessage = '';
        this.noul              = 0;
        this.choiceKey         = '';
        this.choiceConf        = 0;
        this.score             = 0;
        this.latencyInference  = 0;
        this.latencyWebmcp     = 0;
        this.latencyTotal      = 0;
        this.toolCards         = mkTools();
        if (resetRunning) this.isRunning = false;
    }

    _setToolState(id, state) {
        this.toolCards = this.toolCards.map(t => {
            if (t.id !== id) return t;
            if (state === 'exec') return { ...t, cardClass: 'tool-card tool-card--exec', icon: '⚡' };
            if (state === 'done') return { ...t, cardClass: 'tool-card tool-card--done', icon: '✅' };
            return t;
        });
    }

    async _type(text) {
        this.displayedMessage = '';
        for (const ch of text) {
            if (this._cancelled) throw new Error('cancelled');
            this.displayedMessage += ch;
            await this._wait(14);
        }
    }

    _wait(ms) {
        return new Promise((resolve, reject) => {
            const t = setTimeout(() => {
                if (this._cancelled) reject(new Error('cancelled'));
                else resolve();
            }, ms);
            this._timers.push(t);
        });
    }
}
