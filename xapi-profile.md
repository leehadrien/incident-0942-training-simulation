# Incident 09:42 xAPI event profile

The application stores xAPI-compatible statements and can be migrated to a conformant Learning Record Store without rewriting the browser event model.

## Actor

Public visitors use an anonymous xAPI account identifier. No name or email address is collected.

```json
{
  "objectType": "Agent",
  "account": {
    "homePage": "https://hadrienlee.com",
    "name": "portfolio-learner-{uuid}"
  }
}
```

## Simulation activity

- ID: `https://hadrienlee.com/activities/incident-0942`
- Type: `http://adlnet.gov/expapi/activities/simulation`

## Events

| Event | Verb | Purpose |
|---|---|---|
| `simulation_launched` | `launched` | Start of a new attempt |
| `evidence_*` | `experienced` | Learner inspects logs, metrics, deployment, or traces |
| `hint_requested` | `interacted` | Learner requests optional coaching |
| `supported_action` | `answered` | Learner selects an evidence-supported action |
| `unsupported_action` | `answered` | Learner selects an unsupported action |
| `dependency_contained` | `interacted` | Retry amplification is stopped |
| `simulation_completed` | `completed` | Final score and outcome are stored |

## Extensions

| Extension IRI | Value |
|---|---|
| `https://hadrienlee.com/xapi/extensions/attempt` | Attempt UUID |
| `https://hadrienlee.com/xapi/extensions/event` | Application event name |
| `https://hadrienlee.com/xapi/extensions/phase` | Diagnose, contain, recover, communicate, or complete |
| `https://hadrienlee.com/xapi/extensions/elapsed_seconds` | Seconds elapsed at event time |

