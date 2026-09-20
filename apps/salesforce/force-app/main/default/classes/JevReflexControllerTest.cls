@IsTest
private class JevReflexControllerTest {

    // ── Mock: 200 OK with full Noul/Choice/Score response ─────────────────────

    private class MockSuccess implements HttpCalloutMock {
        public HttpResponse respond(HttpRequest req) {
            System.assertEquals('POST', req.getMethod());
            System.assert(req.getEndpoint().contains('/v1/systemone'));

            HttpResponse res = new HttpResponse();
            res.setStatusCode(200);
            res.setHeader('Content-Type', 'application/json');
            res.setBody(JSON.serialize(new Map<String, Object>{
                'model' => 'flash-local',
                'answers' => new Map<String, Object>{
                    'is_critical' => new Map<String, Object>{
                        'type' => 'noul', 'noul' => 0.92
                    },
                    'recommended_action' => new Map<String, Object>{
                        'type' => 'choice', 'choice' => 'APPROVE_MAX_REFUND',
                        'confidence' => 0.87,
                        'probabilities' => new Map<String, Object>{
                            'APPROVE_MAX_REFUND' => 0.87, 'ESCALATE' => 0.10, 'STANDARD_RESPONSE' => 0.03
                        }
                    },
                    'urgency_level' => new Map<String, Object>{
                        'type' => 'score', 'score' => 2.61, 'confidence' => 0.79
                    }
                },
                'usage' => new Map<String, Object>{ 'input_tokens' => 312, 'output_tokens' => 0 }
            }));
            return res;
        }
    }

    // ── Mock: 500 error ────────────────────────────────────────────────────────

    private class MockError implements HttpCalloutMock {
        public HttpResponse respond(HttpRequest req) {
            HttpResponse res = new HttpResponse();
            res.setStatusCode(500);
            res.setBody('Internal Server Error');
            return res;
        }
    }

    // ── Tests ──────────────────────────────────────────────────────────────────

    @IsTest
    static void testEvaluate_success() {
        Test.setMock(HttpCalloutMock.class, new MockSuccess());

        String state = '{"message":"System down. Cancel NOW!","tier":"Enterprise"}';
        String questions = '{"is_critical":{"type":"noul","instructions":"Critical VIP churn risk?"},"recommended_action":{"type":"choice","instructions":"Best action?","criteria":{"APPROVE_MAX_REFUND":"Full refund","ESCALATE":"Escalate"}}}';

        Test.startTest();
        Map<String, Object> result = JevReflexController.evaluate(state, questions);
        Test.stopTest();

        System.assertEquals('api', result.get('source'));
        System.assertNotEquals(null, result.get('answers'));
        System.assertNotEquals(null, result.get('latency_ms'));
    }

    @IsTest
    static void testEvaluate_apiError_fallsBackToSimulation() {
        Test.setMock(HttpCalloutMock.class, new MockError());

        Test.startTest();
        Map<String, Object> result = JevReflexController.evaluate('{"msg":"test"}', '{}');
        Test.stopTest();

        System.assertEquals('simulated', result.get('source'));
        System.assertNotEquals(null, result.get('answers'));
    }

    @IsTest
    static void testSimulatedResponse_shape() {
        Map<String, Object> sim = JevReflexController.simulatedResponse();
        System.assertEquals('simulated', sim.get('source'));

        Map<String, Object> answers = (Map<String, Object>) sim.get('answers');
        System.assert(answers.containsKey('is_critical'));
        System.assert(answers.containsKey('recommended_action'));
        System.assert(answers.containsKey('urgency_level'));

        Map<String, Object> noul = (Map<String, Object>) answers.get('is_critical');
        System.assertEquals('noul', noul.get('type'));
        System.assert((Decimal) noul.get('noul') > 0.9);
    }

    @IsTest
    static void testGenerateResolution() {
        Test.startTest();
        String msg = JevReflexController.generateResolution('Tanaka Corp', 50000);
        Test.stopTest();

        System.assert(msg.contains('Tanaka Corp'));
        System.assert(msg.contains('$50000'));
        System.assert(msg.contains('REF-'));
    }
}
