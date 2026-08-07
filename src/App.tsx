import { useEffect, useMemo, useRef, useState } from 'react'
import { getActorId, startSession, trackEvent, type Phase } from './tracking'

type Choice = {
  id: string
  label: string
  note: string
  correct: boolean
  coach: string
  audio: string
}

type Metric = {
  label: string
  value: string
  tone: 'neutral' | 'warn' | 'critical' | 'healthy'
  detail: string
  audio: string
}

type TextSize = 'compact' | 'standard' | 'large'

type Feedback = {
  tone: 'info' | 'success' | 'warning'
  title: string
  detail: string
}

const initialMetrics: Metric[] = [
  { label: 'CHECKOUT SUCCESS', value: '81.6%', tone: 'critical', detail: 'Down from 99.2%', audio: 'metric-checkout-success' },
  { label: 'REQUESTS', value: '4,820 / SEC', tone: 'neutral', detail: 'Traffic is steady', audio: 'metric-requests' },
  { label: 'ERROR RATE', value: '18.4%', tone: 'critical', detail: 'Up from 0.8%', audio: 'metric-error-rate' },
  { label: 'RETRY RATE', value: '2.7 / REQUEST', tone: 'warn', detail: 'Normal is 0.2', audio: 'metric-retry-rate' },
  { label: 'INCIDENT ELAPSED', value: '00:08:42', tone: 'neutral', detail: 'SEV-2 active', audio: 'metric-incident-elapsed' },
]

const phaseChoices: Record<Exclude<Phase, 'complete'>, Choice[]> = {
  diagnose: [
    { id: 'inventory_dependency', label: 'INVENTORY DEPENDENCY', note: 'Trace the timeout and retry amplification.', correct: true, coach: 'There it is. Inventory timed out, Checkout multiplied it, and now everybody is invited to the incident.', audio: 'diagnose-correct' },
    { id: 'database_cpu', label: 'PRIMARY DATABASE', note: 'Investigate the database CPU first.', correct: false, coach: 'The database appreciates the concern. It is healthy, innocent, and somehow still in the group chat.', audio: 'diagnose-database' },
    { id: 'traffic_spike', label: 'TRAFFIC SPIKE', note: 'Assume demand exceeded capacity.', correct: false, coach: 'Traffic is steady. The retries are multiplying like they heard there was free food.', audio: 'diagnose-traffic' },
  ],
  contain: [
    { id: 'dependency_protection', label: 'ENABLE DEPENDENCY PROTECTION', note: 'Open the existing circuit breaker and stop new retry amplification.', correct: true, coach: 'Good. Circuit open. We stopped sending traffic to a service that was already having a terrible morning.', audio: 'contain-correct' },
    { id: 'rollback_first', label: 'ROLL BACK DEPLOYMENT', note: 'A valid recovery step, but slower than immediate containment.', correct: false, coach: 'Right instinct, wrong order. Stop the retry storm first, then roll back the release that started all this.', audio: 'contain-rollback-first' },
    { id: 'scale_database', label: 'SCALE DATABASE', note: 'Add capacity to the healthy database.', correct: false, coach: 'More database, same outage. We just bought the innocent bystander a larger chair.', audio: 'contain-scale-database' },
  ],
  recover: [
    { id: 'rollback_v382', label: 'ROLL BACK v3.8.2', note: 'Restore bounded retries and the prior circuit-breaker configuration.', correct: true, coach: 'Clean rollback. Nice. Now prove recovery before anyone types resolved with confidence they have not earned.', audio: 'recover-correct' },
    { id: 'restart_all', label: 'RESTART ALL SERVICES', note: 'Restart the full production stack.', correct: false, coach: 'Bold. Also unnecessary. The healthy services did not need a trust fall.', audio: 'recover-restart-all' },
    { id: 'resume_traffic', label: 'RESUME FULL TRAFFIC', note: 'Reopen checkout before checking recovery.', correct: false, coach: 'Not yet. A green light without evidence is just optimism wearing a dashboard.', audio: 'recover-resume-traffic' },
  ],
  communicate: [
    { id: 'evidence_update', label: 'SEND EVIDENCE-BASED UPDATE', note: 'State impact, action, recovery evidence, and next checkpoint.', correct: true, coach: 'Clear impact, action, evidence, next check. Beautiful. Nobody had to translate “we are looking into it.”', audio: 'communicate-correct' },
    { id: 'resolved_update', label: 'DECLARE INCIDENT RESOLVED', note: 'Close immediately after the rollback completes.', correct: false, coach: 'Recovery is trending. Resolved is a claim, and claims need receipts.', audio: 'communicate-resolved' },
    { id: 'technical_dump', label: 'SEND THE FULL LOG OUTPUT', note: 'Paste raw logs into the stakeholder channel.', correct: false, coach: 'Technically accurate. Practically, you just assigned everyone homework during an incident.', audio: 'communicate-log-dump' },
  ],
}

const metricCoachLines: Record<string, string> = {
  'CHECKOUT SUCCESS': 'Checkout success fell off a cliff. Politely, but still a cliff.',
  'REQUESTS': 'Traffic is steady. So demand did not wake up and choose violence.',
  'ERROR RATE': 'Eighteen point four percent is not background noise. That is the incident waving at us.',
  'RETRY RATE': 'Two point seven attempts per request. The retries are creating their own customer base.',
  'INCIDENT ELAPSED': 'Eight minutes in. We have time to be deliberate, but not enough time for interpretive debugging.',
}

const phaseLabels: Record<Phase, string> = {
  diagnose: 'DIAGNOSE',
  contain: 'CONTAIN',
  recover: 'RECOVER',
  communicate: 'COMMUNICATE',
  complete: 'COMPLETE',
}

const phaseNumber: Record<Phase, number> = { diagnose: 1, contain: 2, recover: 3, communicate: 4, complete: 4 }

type PhaseGuidance = {
  objective: string
  instruction: string
  doNow: string
  lookFor: string
  success: string
}

const phaseGuidance: Record<Phase, PhaseGuidance> = {
  diagnose: {
    objective: 'Find what started the problem',
    instruction: 'Click any two boxes in Live Metrics or Evidence. Then use what you found to choose the original cause.',
    doNow: 'Click two metrics or evidence cards. Watch Signals change from 0 / 2 to 2 / 2. Then select one cause.',
    lookFor: 'Traffic is steady. Version 3.8.2 changed retry behavior. Inventory is timing out. Checkout is retrying three times.',
    success: 'The decision cards unlock, and you can name both the failing service and the behavior making it worse.',
  },
  contain: {
    objective: 'Stop the problem from spreading',
    instruction: 'Choose the action that stops Checkout from sending more requests to the failing Inventory service.',
    doNow: 'Select the fastest safety action. Do not fix or restart everything yet.',
    lookFor: 'The correct action stops retries immediately and changes the service map from degraded to contained.',
    success: 'Retries are blocked and the problem stops growing.',
  },
  recover: {
    objective: 'Return to the last working version',
    instruction: 'Choose how to remove version 3.8.2, then verify the red and amber health numbers return to normal.',
    doNow: 'Choose the recovery action connected to the software change at 09:35.',
    lookFor: 'Checkout success should rise. Error rate and retry rate should fall and turn green.',
    success: 'Checkout success, error rate, and retry rate return to normal.',
  },
  communicate: {
    objective: 'Tell the team what happened and what comes next',
    instruction: 'Choose the update that includes customer impact, action taken, proof of recovery, and the next checkpoint.',
    doNow: 'Choose the message a manager could understand and act on without reading raw logs.',
    lookFor: 'The message answers four questions: What broke? What did we do? How do we know it is recovering? When will we check again?',
    success: 'The team receives a short, complete, evidence-based update.',
  },
  complete: {
    objective: 'Incident stabilized',
    instruction: 'Review your score and badges, then choose Retry to reset the entire mission and improve your response.',
    doNow: 'Review the result, open your attempt data, or choose Retry for a fresh mission.',
    lookFor: 'A stronger retry uses fewer hints, fewer unsupported actions, and faster containment.',
    success: 'The stack is stable and the learning record is stored.',
  },
}

function createAmbientEngine() {
  const AudioContextClass = window.AudioContext ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AudioContextClass) return () => undefined

  const context = new AudioContextClass()
  const master = context.createGain()
  const filter = context.createBiquadFilter()
  const low = context.createOscillator()
  const high = context.createOscillator()
  const lfo = context.createOscillator()
  const lfoGain = context.createGain()

  master.gain.setValueAtTime(0.0001, context.currentTime)
  master.gain.exponentialRampToValueAtTime(0.026, context.currentTime + 1.4)
  filter.type = 'lowpass'
  filter.frequency.value = 290
  filter.Q.value = 0.8

  low.type = 'sine'
  low.frequency.value = 55
  high.type = 'triangle'
  high.frequency.value = 82.41
  lfo.type = 'sine'
  lfo.frequency.value = 0.07
  lfoGain.gain.value = 90

  lfo.connect(lfoGain)
  lfoGain.connect(filter.frequency)
  low.connect(filter)
  high.connect(filter)
  filter.connect(master)
  master.connect(context.destination)
  low.start()
  high.start()
  lfo.start()

  return () => {
    const now = context.currentTime
    master.gain.cancelScheduledValues(now)
    master.gain.setValueAtTime(Math.max(master.gain.value, 0.0001), now)
    master.gain.exponentialRampToValueAtTime(0.0001, now + 0.35)
    window.setTimeout(() => context.close().catch(() => undefined), 420)
  }
}

function playUiTone(tone: 'success' | 'warning') {
  const AudioContextClass = window.AudioContext ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AudioContextClass) return
  const context = new AudioContextClass()
  const gain = context.createGain()
  const first = context.createOscillator()
  const second = context.createOscillator()
  const now = context.currentTime

  gain.gain.setValueAtTime(0.0001, now)
  gain.gain.exponentialRampToValueAtTime(0.05, now + 0.02)
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.35)
  first.type = 'sine'
  second.type = 'sine'
  first.frequency.value = tone === 'success' ? 523.25 : 196
  second.frequency.value = tone === 'success' ? 659.25 : 146.83
  first.connect(gain)
  second.connect(gain)
  gain.connect(context.destination)
  first.start(now)
  second.start(now + 0.07)
  first.stop(now + 0.24)
  second.stop(now + 0.32)
  window.setTimeout(() => context.close().catch(() => undefined), 450)
}

function formatDuration(seconds: number) {
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

function ServiceTopology({ contained, recovered }: { contained: boolean; recovered: boolean }) {
  const services = [
    { id: 'web', label: 'WEB APP', x: 8, y: 42, status: 'healthy' },
    { id: 'gateway', label: 'API GATEWAY', x: 28, y: 42, status: 'healthy' },
    { id: 'checkout', label: 'CHECKOUT API', x: 49, y: 22, status: contained ? 'warn' : 'critical' },
    { id: 'inventory', label: 'INVENTORY', x: 70, y: 22, status: recovered ? 'healthy' : contained ? 'isolated' : 'critical' },
    { id: 'queue', label: 'MESSAGE QUEUE', x: 49, y: 64, status: contained ? 'warn' : 'critical' },
    { id: 'db', label: 'PRIMARY DB', x: 70, y: 64, status: 'healthy' },
    { id: 'replica', label: 'REPLICA', x: 86, y: 64, status: 'healthy' },
  ]

  return (
    <div className="topology" aria-label="Interactive service topology showing a retry-driven failure between Checkout API and Inventory Service">
      <svg className="paths" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        <path className="path healthy" d="M14 46 L28 46" />
        <path className="path healthy" d="M36 43 L48 28" />
        <path className={`path ${recovered ? 'healthy' : contained ? 'isolated' : 'critical'}`} d="M57 26 L70 26" />
        <path className={`path retry ${contained ? 'paused' : ''}`} d="M70 30 C62 38 62 18 56 23" />
        <path className={`path ${contained ? 'warn' : 'critical'}`} d="M52 31 L52 63" />
        <path className="path healthy" d="M58 68 L70 68" />
        <path className="path healthy" d="M78 68 L86 68" />
      </svg>
      {services.map((service) => (
        <div
          className={`service-node ${service.status}`}
          style={{ left: `${service.x}%`, top: `${service.y}%` }}
          key={service.id}
        >
          <span className="node-light" />
          <span>{service.label}</span>
          <small>{service.status === 'critical' ? 'FAILING' : service.status === 'isolated' ? 'CIRCUIT OPEN' : service.status === 'warn' ? 'RECOVERING' : 'HEALTHY'}</small>
        </div>
      ))}
      {!recovered && <div className={`retry-badge ${contained ? 'paused' : ''}`}>{contained ? 'RETRIES BLOCKED' : 'RETRY × 3'}</div>}
      <div className="topology-legend">
        <span><i className="healthy-dot" /> Healthy</span>
        <span><i className="warn-dot" /> Amplified load</span>
        <span><i className="critical-dot" /> Originating failure</span>
      </div>
    </div>
  )
}

function CoachPanel({ line, speaking, onReplay }: { line: string; speaking: boolean; onReplay: () => void }) {
  return (
    <aside className="coach-panel" aria-label="Incident coach">
      <div className="coach-video">
        <div className={`coach-placeholder ${speaking ? 'speaking' : ''}`} role="img" aria-label="Present-day technical coach speaking to the learner">
          <img src="/coach.webp" alt="Mara, a present-day technical incident coach" />
        </div>
        <div className="video-controls">
          <button onClick={onReplay} aria-label="Replay coach line">▶</button>
          <span className={`waveform ${speaking ? 'active' : ''}`} aria-hidden="true">
            {Array.from({ length: 12 }).map((_, index) => <i key={index} />)}
          </span>
          <span className="cc" aria-label="Captions enabled">CC</span>
        </div>
      </div>
      <div className="coach-copy" aria-live="polite">
        <span className="eyebrow">MARA · INCIDENT COACH</span>
        <p>“{line}”</p>
      </div>
    </aside>
  )
}

function RelayNineLogo({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`company-logo ${compact ? 'compact' : ''}`} aria-label="Relay Nine Commerce">
      <svg viewBox="0 0 34 34" aria-hidden="true">
        <rect x="3" y="4" width="19" height="15" rx="4" />
        <path d="M11 12h19v18H11z" />
        <circle cx="26" cy="8" r="3" />
      </svg>
      <span><strong>RELAY NINE</strong><small>COMMERCE</small></span>
    </div>
  )
}

function Dashboard() {
  const [summary, setSummary] = useState<any>(null)
  const actorId = useMemo(() => getActorId(), [])

  useEffect(() => {
    fetch(`/api/dashboard/summary?actor_id=${encodeURIComponent(actorId)}`)
      .then((response) => response.json())
      .then(setSummary)
      .catch(() => setSummary({ error: true }))
  }, [actorId])

  if (!summary) return <div className="loading">Loading attempt history…</div>
  if (summary.error) return <div className="loading">Attempt history is temporarily unavailable.</div>

  return (
    <main className="dashboard-page">
      <header className="dashboard-header">
        <div>
          <span className="eyebrow">PROJECT 03 · LIVE LEARNING DATA</span>
          <h1>INCIDENT ATTEMPT HISTORY</h1>
          <p>Repeated performance from Incident 09:42, captured as xAPI-compatible learning events.</p>
        </div>
        <a className="primary-link" href="/training/incident-0942">RUN SIMULATION</a>
      </header>
      <section className="summary-grid" aria-label="Attempt summary">
        {[
          ['TOTAL ATTEMPTS', summary.total_attempts],
          ['AVERAGE SCORE', `${summary.average_score}%`],
          ['BEST SCORE', `${summary.best_score}%`],
          ['AVG. CONTAINMENT', `${summary.average_time_to_contain_seconds}s`],
          ['HINTS USED', summary.total_hints],
          ['UNSUPPORTED ACTIONS', summary.total_unsupported_actions],
        ].map(([label, value]) => (
          <article className="summary-card" key={label}>
            <span>{label}</span><strong>{value}</strong>
          </article>
        ))}
      </section>
      <section className="attempt-table-wrap">
        <div className="section-heading"><span>ATTEMPT LOG</span><span>{summary.attempts.length} RECENT</span></div>
        {summary.attempts.length === 0 ? (
          <div className="empty-state">Complete the simulation to create your first tracked attempt.</div>
        ) : (
          <div className="attempt-table" role="table">
            <div className="attempt-row table-head" role="row">
              <span>STARTED</span><span>OUTCOME</span><span>SCORE</span><span>HINTS</span><span>CONTAINMENT</span>
            </div>
            {summary.attempts.map((attempt: any) => (
              <div className="attempt-row" role="row" key={attempt.id}>
                <span>{new Date(attempt.started_at).toLocaleString()}</span>
                <span className={attempt.outcome === 'stabilized' ? 'status-good' : 'status-muted'}>{attempt.outcome ?? 'IN PROGRESS'}</span>
                <strong>{attempt.score}%</strong>
                <span>{attempt.hints}</span>
                <span>{attempt.time_to_contain_seconds ? `${attempt.time_to_contain_seconds}s` : 'N/A'}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </main>
  )
}

function Simulation() {
  const [actorId] = useState(() => getActorId())
  const [attemptId, setAttemptId] = useState<string | null>(null)
  const [briefingOpen, setBriefingOpen] = useState(true)
  const [tourOpen, setTourOpen] = useState(false)
  const [missionStarted, setMissionStarted] = useState(false)
  const [musicEnabled, setMusicEnabled] = useState(true)
  const [textSize, setTextSize] = useState<TextSize>(() => (localStorage.getItem('incident-0942-text-size') as TextSize) || 'standard')
  const [phase, setPhase] = useState<Phase>('diagnose')
  const [score, setScore] = useState(0)
  const [streak, setStreak] = useState(0)
  const [reward, setReward] = useState<string | null>(null)
  const [wrongActions, setWrongActions] = useState(0)
  const [hintCount, setHintCount] = useState(0)
  const [selectedEvidence, setSelectedEvidence] = useState<string[]>([])
  const [coachLine, setCoachLine] = useState('All right, checkout is on fire. Figuratively, which is the only good news. Start with the evidence.')
  const [coachAudio, setCoachAudio] = useState('intro')
  const [speaking, setSpeaking] = useState(false)
  const [contained, setContained] = useState(false)
  const [recovered, setRecovered] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [trackingStatus, setTrackingStatus] = useState<'starting' | 'tracked' | 'offline'>('starting')
  const [feedback, setFeedback] = useState<Feedback>({
    tone: 'info',
    title: 'Mission briefing required',
    detail: 'Read the incident brief, choose your accessibility settings, then begin the simulation.',
  })
  const startedAt = useRef(Date.now())
  const currentAudio = useRef<HTMLAudioElement | null>(null)
  const stopAmbient = useRef<(() => void) | null>(null)
  const speakingTimer = useRef<number | null>(null)
  const rewardTimer = useRef<number | null>(null)

  useEffect(() => {
    if (!missionStarted) return
    let active = true
    startSession(actorId)
      .then((id) => {
        if (!active) return
        setAttemptId(id)
        setTrackingStatus('tracked')
        trackEvent(actorId, id, { verb: 'launched', event: 'simulation_launched', phase: 'diagnose' }).catch(() => setTrackingStatus('offline'))
      })
      .catch(() => setTrackingStatus('offline'))
    return () => { active = false }
  }, [actorId, missionStarted])

  useEffect(() => {
    if (!missionStarted) return
    const timer = window.setInterval(() => setElapsed((Date.now() - startedAt.current) / 1000), 1000)
    return () => window.clearInterval(timer)
  }, [missionStarted])

  useEffect(() => {
    localStorage.setItem('incident-0942-text-size', textSize)
  }, [textSize])

  useEffect(() => {
    if (!missionStarted || !musicEnabled) {
      stopAmbient.current?.()
      stopAmbient.current = null
      return
    }
    stopAmbient.current = createAmbientEngine()
    return () => {
      stopAmbient.current?.()
      stopAmbient.current = null
    }
  }, [missionStarted, musicEnabled])

  useEffect(() => () => {
    currentAudio.current?.pause()
    stopAmbient.current?.()
    if (speakingTimer.current) window.clearTimeout(speakingTimer.current)
    if (rewardTimer.current) window.clearTimeout(rewardTimer.current)
  }, [])

  const showReward = (message: string) => {
    if (rewardTimer.current) window.clearTimeout(rewardTimer.current)
    setReward(message)
    rewardTimer.current = window.setTimeout(() => setReward(null), 1800)
  }

  const beginMission = () => {
    startedAt.current = Date.now()
    setMissionStarted(true)
    setBriefingOpen(false)
    setTourOpen(false)
    setFeedback({
      tone: 'info',
      title: 'First step: click two evidence boxes',
      detail: 'Click any two boxes in Live Metrics or Evidence. When Signals shows 2 / 2, scroll to the decision cards and choose where the failure began.',
    })
    speak('You are on call. Checkout success is collapsing, traffic is steady, and version 3.8.2 just changed retry behavior. Inspect two signals before you make the first call.', 'intro')
  }

  const continueFromBriefing = () => {
    if (missionStarted) {
      setBriefingOpen(false)
      return
    }
    setBriefingOpen(false)
    setTourOpen(true)
  }

  const speak = (line: string, audioKey: string) => {
    setCoachLine(line)
    setCoachAudio(audioKey)
    currentAudio.current?.pause()
    if (speakingTimer.current) window.clearTimeout(speakingTimer.current)

    const audio = new Audio(`/audio/${audioKey}.mp3`)
    currentAudio.current = audio
    setSpeaking(true)
    const finish = () => {
      if (currentAudio.current === audio) setSpeaking(false)
    }
    audio.onended = finish
    audio.onerror = finish
    audio.play().catch(() => {
      speakingTimer.current = window.setTimeout(finish, Math.min(7200, Math.max(2600, line.length * 48)))
    })
  }

  const sendEvent = (options: Parameters<typeof trackEvent>[2]) => {
    if (!attemptId) return
    trackEvent(actorId, attemptId, options).catch(() => setTrackingStatus('offline'))
  }

  const inspectEvidence = (id: string, line: string, audioKey: string) => {
    if (selectedEvidence.includes(id)) return
    const nextEvidenceCount = selectedEvidence.length + 1
    setSelectedEvidence((items) => [...items, id])
    speak(line, audioKey)
    setFeedback({
      tone: nextEvidenceCount >= 2 ? 'success' : 'info',
      title: nextEvidenceCount >= 2 ? 'Decision unlocked' : 'Signal captured',
      detail: nextEvidenceCount >= 2
        ? 'Signals now shows 2 / 2. Scroll to the decision cards and choose where the failure began.'
        : 'Signals now shows 1 / 2. Click one more metric or evidence card to unlock the decision cards.',
    })
    sendEvent({ verb: 'experienced', event: `evidence_${id}`, phase, objectId: `incident-0942/evidence/${id}` })
  }

  const requestHint = () => {
    setHintCount((count) => count + 1)
    showReward('HINT USED · INTEGRITY -5')
    const hints: Record<Exclude<Phase, 'complete'>, { line: string; audio: string }> = {
      diagnose: { line: 'Look for the number growing faster than traffic. The retries are being very loud about it.', audio: 'hint-diagnose' },
      contain: { line: 'Before fixing the release, stop feeding the failing dependency. It has had enough.', audio: 'hint-contain' },
      recover: { line: 'The bad behavior arrived at 09:35. Send that deployment back where it came from.', audio: 'hint-recover' },
      communicate: { line: 'Impact, action, evidence, next checkpoint. Four things. No novella.', audio: 'hint-communicate' },
    }
    if (phase !== 'complete') speak(hints[phase].line, hints[phase].audio)
    if (phase !== 'complete') {
      setFeedback({ tone: 'info', title: 'Coach hint', detail: `${hints[phase].line} A hint costs 5 integrity points.` })
    }
    sendEvent({ verb: 'interacted', event: 'hint_requested', phase })
  }

  const choose = (choice: Choice) => {
    sendEvent({ verb: 'answered', event: choice.correct ? 'supported_action' : 'unsupported_action', phase, response: choice.id, success: choice.correct, objectId: `incident-0942/decision/${phase}` })
    speak(choice.coach, choice.audio)
    if (!choice.correct) {
      setWrongActions((count) => count + 1)
      setStreak(0)
      showReward('UNSUPPORTED ACTION · INTEGRITY -15')
      if (musicEnabled) playUiTone('warning')
      setFeedback({
        tone: 'warning',
        title: 'Unsupported action: integrity -15',
        detail: `That choice does not complete this task. Read Look for and You are done when, then choose again. The mission continues.`,
      })
      return
    }

    const points = phase === 'diagnose' ? 30 : phase === 'contain' ? 30 : phase === 'recover' ? 25 : 15
    const nextScore = Math.max(0, score + points - hintCount * 2 - wrongActions * 3)
    setScore(nextScore)
    setStreak((count) => count + 1)
    showReward(`PHASE CLEARED · +${points} XP`)
    if (musicEnabled) playUiTone('success')
    const nextPhase: Phase = phase === 'diagnose' ? 'contain' : phase === 'contain' ? 'recover' : phase === 'recover' ? 'communicate' : 'complete'
    setFeedback({
      tone: 'success',
      title: phase === 'communicate' ? 'Mission complete' : `Phase cleared: +${points} base points`,
      detail: nextPhase === 'complete' ? phaseGuidance.complete.success : `Next objective: ${phaseGuidance[nextPhase].objective}. ${phaseGuidance[nextPhase].instruction}`,
    })

    if (phase === 'diagnose') setPhase('contain')
    else if (phase === 'contain') {
      setContained(true)
      setPhase('recover')
      sendEvent({ verb: 'interacted', event: 'dependency_contained', phase: 'contain', response: choice.id, success: true, elapsedSeconds: Math.round(elapsed) })
    } else if (phase === 'recover') {
      setRecovered(true)
      setPhase('communicate')
    } else if (phase === 'communicate') {
      setPhase('complete')
      sendEvent({ verb: 'completed', event: 'simulation_completed', phase: 'complete', success: nextScore >= 70, score: nextScore, elapsedSeconds: Math.round(elapsed) })
    }
  }

  const reset = () => window.location.reload()

  const currentChoices = phase === 'complete' ? [] : phaseChoices[phase]
  const diagnosisReady = phase !== 'diagnose' || selectedEvidence.length >= 2
  const integrity = Math.max(0, 100 - wrongActions * 15 - hintCount * 5)
  const rank = phase === 'complete' ? 'STACK STABILIZER' : score >= 60 ? 'INCIDENT LEAD' : score >= 30 ? 'RESPONDER' : 'ON-CALL ENGINEER'
  const achievements = [
    selectedEvidence.length >= 4 ? 'SIGNAL HUNTER' : null,
    wrongActions === 0 ? 'CLEAN RUN' : null,
    hintCount === 0 ? 'SELF-SUFFICIENT' : null,
    elapsed <= 300 ? 'FAST CONTAINMENT' : null,
  ].filter(Boolean) as string[]
  const recoveryMetrics = recovered
    ? initialMetrics.map((metric) => metric.label === 'CHECKOUT SUCCESS'
      ? { ...metric, value: '99.1%', tone: 'healthy' as const, detail: 'Recovered' }
      : metric.label === 'ERROR RATE'
        ? { ...metric, value: '0.9%', tone: 'healthy' as const, detail: 'Back in range' }
        : metric.label === 'RETRY RATE'
          ? { ...metric, value: '0.2 / REQUEST', tone: 'healthy' as const, detail: 'Bounded' }
          : metric)
    : initialMetrics

  const currentDoNow = phase === 'diagnose' && selectedEvidence.length < 2
    ? `Click ${2 - selectedEvidence.length} more metric or evidence card${2 - selectedEvidence.length === 1 ? '' : 's'}. Then choose one cause.`
    : phase === 'diagnose'
      ? 'Signals shows 2 / 2. Choose one cause from the three decision cards below.'
      : phaseGuidance[phase].doNow

  return (
    <main className="simulation-shell" data-text-size={textSize}>
      {briefingOpen && (
        <div className="briefing-backdrop" role="presentation">
          <section className="briefing-modal" role="dialog" aria-modal="true" aria-labelledby="briefing-title" aria-describedby="briefing-summary">
            <div className="briefing-status">
              <span><i /> RELAY NINE COMMERCE · SIMULATED SEV-2</span>
              <span>09:42 LOCAL</span>
            </div>
            <div className="briefing-hero">
              <span className="eyebrow">MISSION BRIEFING · INCIDENT 09:42</span>
              <h2 id="briefing-title">CHECKOUT IS FAILING.<br />YOU ARE NOW ON CALL.</h2>
              <p id="briefing-summary">At Relay Nine Commerce, checkout success fell from 99.2% to 81.6% seven minutes after release v3.8.2. Your job is to find the cause, stop the problem from spreading, restore the working version, and tell the team what happened.</p>
            </div>

            <div className="novice-note" role="note">
              <span>START HERE</span>
              <div><strong>No coding or incident-response experience is required.</strong><p>Every technical term is explained. The mission tells you what to click, what to look for, and when each task is complete.</p></div>
            </div>

            <div className="outcome-callout">
              <span>ON-THE-JOB PERFORMANCE OUTCOME</span>
              <strong>Use production evidence to isolate a dependency failure, stop retry amplification, verify recovery, and give the team a decision-ready incident update.</strong>
              <p>Target performance: contain the failure before recovery, finish with at least 80 integrity, and complete the response with no unsupported actions.</p>
            </div>

            <div className="briefing-grid">
              <article>
                <span className="briefing-number">01</span>
                <div><strong>CLICK TWO BOXES</strong><p>Click any two boxes in Live Metrics or Evidence. Selected boxes glow green and Signals changes from 0 / 2 to 2 / 2.</p></div>
              </article>
              <article>
                <span className="briefing-number">02</span>
                <div><strong>CHOOSE ONE ACTION</strong><p>When the decision cards unlock, choose the action best supported by what you inspected.</p></div>
              </article>
              <article>
                <span className="briefing-number">03</span>
                <div><strong>CHECK THE RESULT</strong><p>A supported choice moves you forward. An unsupported choice explains the problem, costs 15 integrity, and lets you choose again.</p></div>
              </article>
              <article>
                <span className="briefing-number">04</span>
                <div><strong>FINISH OR RETRY</strong><p>Complete all four tasks, review your score, then choose Retry to reset the entire mission and improve your result.</p></div>
              </article>
            </div>

            <details className="plain-glossary">
              <summary>PLAIN-LANGUAGE GLOSSARY <span>OPEN WHEN YOU NEED IT</span></summary>
              <dl>
                <div><dt>INCIDENT</dt><dd>An unexpected problem affecting customers or systems.</dd></div>
                <div><dt>SERVICE</dt><dd>One part of a product that does a specific job.</dd></div>
                <div><dt>DEPENDENCY</dt><dd>A service that another service needs in order to work.</dd></div>
                <div><dt>RETRY</dt><dd>Automatically trying the same request again.</dd></div>
                <div><dt>CIRCUIT BREAKER</dt><dd>A safety switch that temporarily stops requests to a failing service.</dd></div>
                <div><dt>ROLLBACK</dt><dd>Returning software to the previous working version.</dd></div>
                <div><dt>METRIC</dt><dd>A number showing current system health.</dd></div>
                <div><dt>SIGNAL</dt><dd>One metric or evidence card you inspected.</dd></div>
              </dl>
            </details>

            <div className="briefing-warning">
              <strong>TRAINING ENVIRONMENT</strong>
              <span>No live systems are affected. A wrong choice never ends the mission. Mara explains what happened, and you choose again.</span>
            </div>

            <div className="briefing-controls">
              <div className="setting-group" aria-label="Text size">
                <span>TEXT SIZE</span>
                <div className="segmented-control">
                  {([['compact', 'Small text'], ['standard', 'Standard text'], ['large', 'Large text']] as const).map(([value, accessibleLabel]) => (
                    <button key={value} className={`text-${value} ${textSize === value ? 'active' : ''}`} onClick={() => setTextSize(value)} aria-label={accessibleLabel} title={accessibleLabel} aria-pressed={textSize === value}>A</button>
                  ))}
                </div>
              </div>
              <button className={`music-toggle ${musicEnabled ? 'active' : ''}`} onClick={() => setMusicEnabled((enabled) => !enabled)} aria-pressed={musicEnabled}>
                <span>MUSIC</span><strong>{musicEnabled ? 'ON' : 'OFF'}</strong>
              </button>
              <button className="begin-button" onClick={continueFromBriefing}>{missionStarted ? 'RETURN TO INCIDENT' : 'CONTINUE TO INTERFACE TOUR'} <span>▶</span></button>
            </div>
            <p className="keyboard-note">Keyboard navigation, visible focus, captions, reduced-motion support, and text resizing are available throughout.</p>
          </section>
        </div>
      )}

      {tourOpen && (
        <div className="briefing-backdrop" role="presentation">
          <section className="tour-modal" role="dialog" aria-modal="true" aria-labelledby="tour-title">
            <div className="briefing-status"><span><i /> INTERFACE ORIENTATION</span><span>STEP 2 OF 2</span></div>
            <div className="tour-heading">
              <span className="eyebrow">BEFORE THE TIMER STARTS</span>
              <h2 id="tour-title">KNOW WHAT TO LOOK AT.<br />KNOW WHAT TO DO NEXT.</h2>
              <p>Follow the numbered areas from 1 to 4. During the mission, the task guide repeats the same three labels: Do this now, Look for, and You are done when.</p>
            </div>
            <div className="interface-map" aria-label="Four interface regions explained">
              <article className="tour-card metrics-tour">
                <span className="tour-index">01</span>
                <div><strong>LIVE METRICS</strong><p>These numbers show how the system is behaving right now. Click any box to inspect it and hear Mara explain why it matters.</p><small>LOOK FOR: Red or amber numbers, sudden changes, and anything marked outside its normal range.</small></div>
              </article>
              <article className="tour-card evidence-tour">
                <span className="tour-index">02</span>
                <div><strong>EVIDENCE AND SERVICE MAP</strong><p>Evidence cards show what changed and where requests slowed down. The service map shows which parts of the product depend on each other.</p><small>DO THIS: Click two metric or evidence boxes before making the first decision.</small></div>
              </article>
              <article className="tour-card coach-tour">
                <span className="tour-index">03</span>
                <div><strong>COACH FEEDBACK</strong><p>Mara reacts after every inspection and decision. Captions stay visible, and the replay control repeats the current line.</p><small>USE IT FOR: Fast feedback without interrupting the incident flow.</small></div>
              </article>
              <article className="tour-card decision-tour">
                <span className="tour-index">04</span>
                <div><strong>TASK GUIDE AND DECISIONS</strong><p>Read Do this now, Look for, and You are done when. Then choose one decision card.</p><small>SCORED: Correct sequence, evidence use, time, hints, unsupported choices, and final communication.</small></div>
              </article>
            </div>
            <div className="tour-footer">
              <button className="secondary-button" onClick={() => { setTourOpen(false); setBriefingOpen(true) }}>BACK TO BRIEF</button>
              <div><span>READY CHECK</span><strong>I will click two evidence boxes, wait for Signals to show 2 / 2, then choose one decision card.</strong></div>
              <button className="begin-button" onClick={beginMission}>START TIMED MISSION <span>▶</span></button>
            </div>
          </section>
        </div>
      )}

      {reward && <div className="reward-pop" role="status"><span>MISSION UPDATE</span><strong>{reward}</strong></div>}

      <header className="topbar">
        <div className="brand-block">
          <RelayNineLogo compact />
          <span className="incident-mark">09:42</span>
          <div><span className="eyebrow">LIVE TECHNICAL TRAINING</span><h1>STABILIZE THE STACK</h1></div>
        </div>
        <div className="topbar-actions">
          <button className="utility-button" onClick={() => setBriefingOpen(true)}>MISSION BRIEF</button>
          {missionStarted && phase !== 'complete' && <button className="utility-button reset-button" onClick={reset}>RESET MISSION</button>}
          <div className="equipment-console" aria-label="Audio and accessibility equipment">
            <span className="equipment-label">FIELD KIT</span>
            <button className={`speaker-button ${musicEnabled ? 'active' : ''}`} onClick={() => setMusicEnabled((enabled) => !enabled)} aria-label={musicEnabled ? 'Turn background music off' : 'Turn background music on'} title={musicEnabled ? 'Background music on' : 'Background music off'} aria-pressed={musicEnabled}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M4 9v6h4l5 4V5L8 9H4z" />
                {musicEnabled ? <><path d="M16 9c1.2 1.4 1.2 4.6 0 6" /><path d="M18.5 6.5c3.2 3 3.2 8 0 11" /></> : <path d="m16 9 5 6m0-6-5 6" />}
              </svg>
              <span>{musicEnabled ? 'ON' : 'OFF'}</span>
            </button>
            <div className="inline-text-control" aria-label="Text size">
              {([['compact', 'Small text'], ['standard', 'Standard text'], ['large', 'Large text']] as const).map(([value, accessibleLabel]) => (
                <button key={value} className={`text-${value} ${textSize === value ? 'active' : ''}`} onClick={() => setTextSize(value)} aria-label={accessibleLabel} title={accessibleLabel} aria-pressed={textSize === value}>A</button>
              ))}
            </div>
          </div>
          <span className={`tracking-pill ${trackingStatus}`}><i />{trackingStatus === 'tracked' ? 'ATTEMPT TRACKED' : trackingStatus === 'offline' ? 'LOCAL MODE' : 'CONNECTING'}</span>
          <a href="/dashboard">VIEW ATTEMPTS</a>
        </div>
      </header>

      <section className="mission-hud" aria-label="Mission status">
        <div className="objective-block">
          <span className="eyebrow">ACTIVE OBJECTIVE</span>
          <strong>{phaseGuidance[phase].objective}</strong>
          <p>{phaseGuidance[phase].instruction}</p>
        </div>
        <div className="phase-track" aria-label={`Phase ${phaseNumber[phase]} of 4`}>
          {(['diagnose', 'contain', 'recover', 'communicate'] as const).map((item, index) => {
            const activeIndex = phase === 'complete' ? 4 : phaseNumber[phase] - 1
            return <span key={item} className={index < activeIndex ? 'complete' : index === activeIndex ? 'active' : ''}><i>{index + 1}</i>{phaseLabels[item]}</span>
          })}
        </div>
        <div className="game-stats">
          <div><span>XP</span><strong>{score}</strong></div>
          <div><span>INTEGRITY</span><strong className={integrity < 55 ? 'danger' : ''}>{integrity}%</strong></div>
          <div><span>SIGNALS</span><strong>{Math.min(selectedEvidence.length, 2)} / 2</strong></div>
          <div><span>STREAK</span><strong>×{streak}</strong></div>
          <div><span>TIME</span><strong>{formatDuration(elapsed)}</strong></div>
        </div>
        <div className="rank-strip"><span>CURRENT RANK</span><strong>{rank}</strong></div>
      </section>

      <section className={`feedback-banner ${feedback.tone}`} aria-live="polite">
        <span>{feedback.tone === 'success' ? '✓' : feedback.tone === 'warning' ? '!' : '→'}</span>
        <div><strong>{feedback.title}</strong><p>{feedback.detail}</p></div>
      </section>

      <section className="metric-strip" aria-label="Live incident metrics">
        {recoveryMetrics.map((metric) => (
          <button className={`metric ${metric.tone}`} key={metric.label} onClick={() => inspectEvidence(metric.label.toLowerCase().replaceAll(' ', '-'), metricCoachLines[metric.label] ?? `${metric.label}: ${metric.detail}.`, metric.audio)}>
            <span>{metric.label}</span><strong>{metric.value}</strong><small>{metric.detail}</small>
          </button>
        ))}
      </section>

      <div className="workspace">
        <aside className="evidence-panel panel">
          <div className="panel-heading"><span>EVIDENCE</span><span>{selectedEvidence.length} INSPECTED</span></div>
          <button className={`evidence-card ${selectedEvidence.includes('deployment') ? 'selected' : ''}`} onClick={() => inspectEvidence('deployment', 'Version 3.8.2 landed seven minutes before the incident. Not proof, but the timing is doing a lot of suspicious work.', 'evidence-deployment')}>
            <span>DEPLOYMENT TIMELINE</span><strong>09:35 · v3.8.2</strong><small>Retry policy modified</small>
          </button>
          <button className={`evidence-card ${selectedEvidence.includes('logs') ? 'selected' : ''}`} onClick={() => inspectEvidence('logs', 'Three immediate attempts for one request. That is not resilience. That is the same problem with a loyalty program.', 'evidence-logs')}>
            <span>APPLICATION LOGS</span>
            <code>09:42:11 ERROR inventory timeout</code>
            <code>09:42:11 WARN attempt 3/3</code>
            <code>09:42:12 WARN queue depth 1460</code>
          </button>
          <button className={`evidence-card ${selectedEvidence.includes('trace') ? 'selected' : ''}`} onClick={() => inspectEvidence('trace', 'Checkout waits 2.6 seconds on Inventory. The database is clean. Please update the suspect list.', 'evidence-trace')}>
            <span>DISTRIBUTED TRACE</span>
            <div className="trace"><i style={{ width: '18%' }} /><i className="bad" style={{ width: '64%' }} /><i style={{ width: '12%' }} /></div>
            <small>Checkout → Inventory: 2.6s</small>
          </button>
        </aside>

        <section className="system-panel panel">
          <div className="panel-heading"><span>SERVICE TOPOLOGY</span><span className={recovered ? 'status-good' : 'status-live'}>{recovered ? 'RECOVERED' : contained ? 'CONTAINED' : 'DEGRADED'}</span></div>
          <ServiceTopology contained={contained} recovered={recovered} />
        </section>

        <CoachPanel line={coachLine} speaking={speaking} onReplay={() => speak(coachLine, coachAudio)} />
      </div>

      <section className="decision-panel panel">
        <div className="decision-heading">
          <div>
            <span className="eyebrow">{phaseLabels[phase]} {phaseNumber[phase].toString().padStart(2, '0')} / 04</span>
            <h2>{phase === 'diagnose' ? 'WHERE DID THE FAILURE BEGIN?' : phase === 'contain' ? 'WHAT SHOULD YOU DO FIRST?' : phase === 'recover' ? 'HOW DO YOU RECOVER SAFELY?' : phase === 'communicate' ? 'WHAT DOES THE TEAM NEED NOW?' : 'STACK STABILIZED'}</h2>
            <p className="decision-instruction">{phaseGuidance[phase].instruction}</p>
          </div>
          {phase !== 'complete' && <button className="hint-button" onClick={requestHint}>REQUEST HINT <span>{hintCount}</span></button>}
        </div>

        {phase !== 'complete' ? (
          <>
            <section className="task-guide" aria-label="Current task instructions">
              <article className="task-now"><span>DO THIS NOW</span><strong>{currentDoNow}</strong></article>
              <article className="task-look"><span>LOOK FOR</span><strong>{phaseGuidance[phase].lookFor}</strong></article>
              <article className="task-done"><span>YOU ARE DONE WHEN</span><strong>{phaseGuidance[phase].success}</strong></article>
            </section>
            {!diagnosisReady && (
              <div className="decision-lock" role="status">
                <span>LOCKED</span>
                <strong>Inspect {2 - selectedEvidence.length} more signal{2 - selectedEvidence.length === 1 ? '' : 's'} to unlock the diagnosis.</strong>
              </div>
            )}
            <div className="choices">
              {currentChoices.map((choice) => (
                <button className="choice-card" key={choice.id} onClick={() => choose(choice)} disabled={!diagnosisReady}>
                  <span className="choice-index">{String.fromCharCode(65 + currentChoices.indexOf(choice))}</span>
                  <span><strong>{choice.label}</strong><small>{choice.note}</small></span>
                  <i>↗</i>
                </button>
              ))}
            </div>
          </>
        ) : (
          <div className="completion">
            <div className="completion-score"><strong>{score}</strong><span>/ 100</span></div>
            <div>
              <h3>{score >= 70 ? 'INCIDENT STABILIZED' : 'RECOVERY NEEDS REVIEW'}</h3>
              <p>{formatDuration(elapsed)} elapsed · {hintCount} hints · {wrongActions} unsupported actions</p>
              <div className="achievement-row" aria-label="Badges earned">
                {achievements.map((achievement) => <span key={achievement}>◆ {achievement}</span>)}
              </div>
              <p className="job-transfer"><strong>NEXT-SHIFT RESOLUTION:</strong> Correlate change and impact, arrest amplification, restore known-good behavior, then explain the evidence and next checkpoint.</p>
            </div>
            <a className="primary-link" href="/dashboard">VIEW ATTEMPT DATA</a>
            <button className="retry-button" onClick={reset}>RETRY</button>
          </div>
        )}
      </section>
    </main>
  )
}

export default function App() {
  return window.location.pathname.startsWith('/dashboard') ? <Dashboard /> : <Simulation />
}
