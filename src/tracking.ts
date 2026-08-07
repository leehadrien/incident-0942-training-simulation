export type Phase = 'diagnose' | 'contain' | 'recover' | 'communicate' | 'complete'

const VERBS = {
  launched: 'http://adlnet.gov/expapi/verbs/launched',
  experienced: 'http://adlnet.gov/expapi/verbs/experienced',
  interacted: 'http://adlnet.gov/expapi/verbs/interacted',
  answered: 'http://adlnet.gov/expapi/verbs/answered',
  completed: 'http://adlnet.gov/expapi/verbs/completed',
} as const

const ATTEMPT_EXT = 'https://hadrienlee.com/xapi/extensions/attempt'
const EVENT_EXT = 'https://hadrienlee.com/xapi/extensions/event'
const PHASE_EXT = 'https://hadrienlee.com/xapi/extensions/phase'
const ELAPSED_EXT = 'https://hadrienlee.com/xapi/extensions/elapsed_seconds'

export function getActorId(): string {
  const key = 'incident-0942-actor-id'
  const existing = localStorage.getItem(key)
  if (existing) return existing
  const actorId = `portfolio-learner-${crypto.randomUUID()}`
  localStorage.setItem(key, actorId)
  return actorId
}

export async function startSession(actorId: string): Promise<string> {
  const response = await fetch('/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ actor_id: actorId }),
  })
  if (!response.ok) throw new Error('Unable to start a tracked session.')
  const body = await response.json()
  return body.attempt_id
}

type EventOptions = {
  verb: keyof typeof VERBS
  event: string
  phase: Phase
  objectId?: string
  objectName?: string
  response?: string
  success?: boolean
  score?: number
  elapsedSeconds?: number
}

export async function trackEvent(actorId: string, attemptId: string, options: EventOptions) {
  const extensions: Record<string, string | number> = {
    [ATTEMPT_EXT]: attemptId,
    [EVENT_EXT]: options.event,
    [PHASE_EXT]: options.phase,
  }
  if (options.elapsedSeconds !== undefined) extensions[ELAPSED_EXT] = options.elapsedSeconds

  const result: Record<string, unknown> = {}
  if (options.response !== undefined) result.response = options.response
  if (options.success !== undefined) result.success = options.success
  if (options.score !== undefined) result.score = { raw: options.score, min: 0, max: 100 }

  const statement = {
    id: crypto.randomUUID(),
    actor: {
      objectType: 'Agent',
      account: { homePage: 'https://hadrienlee.com', name: actorId },
    },
    verb: {
      id: VERBS[options.verb],
      display: { 'en-US': options.verb },
    },
    object: {
      id: `https://hadrienlee.com/activities/${options.objectId ?? 'incident-0942'}`,
      definition: {
        name: { 'en-US': options.objectName ?? 'Incident 09:42: Stabilize the Stack' },
        type: 'http://adlnet.gov/expapi/activities/simulation',
      },
    },
    context: { extensions },
    ...(Object.keys(result).length ? { result } : {}),
    timestamp: new Date().toISOString(),
  }

  const response = await fetch('/api/xapi/statements', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(statement),
    keepalive: true,
  })
  if (!response.ok) throw new Error('Unable to store learning event.')
}

