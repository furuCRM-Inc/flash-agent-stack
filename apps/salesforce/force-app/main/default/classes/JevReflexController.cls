/**
 * JevReflexController
 * Apex callout to the FlashAgent backend (Cloudflare Workers / Vercel / Railway).
 * Endpoint is read from Named Credential — swap backends without touching code.
 *
 * Named Credential: FlashAgent_Backend
 *   Endpoint: https://your-worker.workers.dev  (or Vercel/Railway URL)
 *   Auth: No Authentication (API key optional via header)
 */
public with sharing class JevReflexController {

    /**
     * Evaluates Noul/Choice/Score questions via the FlashAgent backend.
     * Falls back to a simulated response when the Named Credential is not configured.
     */
    @AuraEnabled
    public static Map<String, Object> evaluate(String stateJson, String questionsJson) {
        try {
            Map<String, Object> body = new Map<String, Object>{
                'model'     => 'flash-local',
                'state'     => stateJson,
                'questions' => (Object) JSON.deserializeUntyped(questionsJson)
            };

            HttpRequest req = new HttpRequest();
            req.setEndpoint('callout:FlashAgent_Backend/v1/systemone');
            req.setMethod('POST');
            req.setHeader('Content-Type', 'application/json');
            req.setHeader('Accept', 'application/json');
            req.setTimeout(10000);
            req.setBody(JSON.serialize(body));

            Long t0 = System.currentTimeMillis();
            HttpResponse res = new Http().send(req);
            Long latencyMs = System.currentTimeMillis() - t0;

            if (res.getStatusCode() != 200) {
                System.debug(LoggingLevel.WARN, 'FlashAgent API error: ' + res.getStatus());
                return simulatedResponse();
            }

            Map<String, Object> parsed = (Map<String, Object>) JSON.deserializeUntyped(res.getBody());
            Map<String, Object> answers = (Map<String, Object>) parsed.get('answers');

            return new Map<String, Object>{
                'source'    => 'api',
                'answers'   => answers,
                'latency_ms'=> latencyMs,
                'model'     => parsed.get('model')
            };

        } catch (Exception e) {
            System.debug(LoggingLevel.WARN, 'FlashAgent callout failed, using simulation: ' + e.getMessage());
            return simulatedResponse();
        }
    }

    /**
     * Simulated fallback — identical response shape as the real API.
     * Used when the backend is not yet deployed or the Named Credential is missing.
     */
    @TestVisible
    private static Map<String, Object> simulatedResponse() {
        return new Map<String, Object>{
            'source'     => 'simulated',
            'latency_ms' => 45,
            'model'      => 'simulated',
            'answers'    => new Map<String, Object>{
                'is_critical' => new Map<String, Object>{
                    'type' => 'noul',
                    'noul' => 0.97
                },
                'recommended_action' => new Map<String, Object>{
                    'type'       => 'choice',
                    'choice'     => 'APPROVE_MAX_REFUND',
                    'confidence' => 0.95,
                    'probabilities' => new Map<String, Object>{
                        'APPROVE_MAX_REFUND' => 0.95,
                        'ESCALATE'           => 0.04,
                        'STANDARD_RESPONSE'  => 0.01
                    }
                },
                'urgency_level' => new Map<String, Object>{
                    'type'       => 'score',
                    'score'      => 2.85,
                    'confidence' => 0.92
                }
            }
        };
    }

    /**
     * Generates a personalised resolution message.
     */
    @AuraEnabled
    public static String generateResolution(String customerName, Decimal refundAmount) {
        String name = String.isBlank(customerName) ? 'Valued Customer' : customerName;
        String txnId = 'REF-' + String.valueOf(System.currentTimeMillis()).right(8);
        return 'Dear ' + name + ' — your full refund of $'
            + String.valueOf(refundAmount.longValue())
            + ' has been authorised (' + txnId + '). '
            + 'Our VIP Retention Team will contact you within 15 minutes.';
    }
}
