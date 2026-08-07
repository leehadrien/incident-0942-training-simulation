import { useEffect, useMemo, useRef, useState } from 'react'
import { getActorId, startSession, trackEvent, type Phase } from './tracking'

type Choice = {
  id: string
  label: string
  technicalLabel?: string
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
type Difficulty = 'guided' | 'standard' | 'challenge'

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
    { id: 'inventory_dependency', label: 'INVENTORY SERVICE FAILED', technicalLabel: 'INVENTORY DEPENDENCY TIMEOUT', note: 'Technical signal: dependency timeout plus repeated requests.', correct: true, coach: 'There it is. Inventory timed out, Checkout multiplied it, and now everybody is invited to the incident.', audio: 'diagnose-correct' },
    { id: 'database_cpu', label: 'THE DATABASE FAILED', technicalLabel: 'PRIMARY DATABASE SATURATION', note: 'This would fit only if the database health was also failing.', correct: false, coach: 'The database appreciates the concern. It is healthy, innocent, and somehow still in the group chat.', audio: 'diagnose-database' },
    { id: 'traffic_spike', label: 'TOO MANY CUSTOMERS ARRIVED', technicalLabel: 'TRAFFIC CAPACITY EVENT', note: 'This would fit only if incoming traffic had increased.', correct: false, coach: 'Traffic is steady. The retries are multiplying like they heard there was free food.', audio: 'diagnose-traffic' },
  ],
  contain: [
    { id: 'dependency_protection', label: 'STOP CALLS TO INVENTORY', technicalLabel: 'OPEN CIRCUIT BREAKER', note: 'Technical action: open the existing circuit breaker.', correct: true, coach: 'Good. Circuit open. We stopped sending traffic to a service that was already having a terrible morning.', audio: 'contain-correct' },
    { id: 'rollback_first', label: 'ROLL BACK THE RELEASE', technicalLabel: 'ROLL BACK DEPLOYMENT', note: 'Useful next, but it does not stop the retry surge immediately.', correct: false, coach: 'Right instinct, wrong order. Stop the retry storm first, then roll back the release that started all this.', audio: 'contain-rollback-first' },
    { id: 'scale_database', label: 'ADD DATABASE CAPACITY', technicalLabel: 'SCALE PRIMARY DATABASE', note: 'The database is healthy, so this does not address the cause.', correct: false, coach: 'More database, same outage. We just bought the innocent bystander a larger chair.', audio: 'contain-scale-database' },
  ],
  recover: [
    { id: 'rollback_v382', label: 'RESTORE THE PREVIOUS VERSION', technicalLabel: 'ROLL BACK v3.8.2', note: 'Technical action: roll back release v3.8.2.', correct: true, coach: 'Clean rollback. Nice. Now prove recovery before anyone types resolved with confidence they have not earned.', audio: 'recover-correct' },
    { id: 'restart_all', label: 'RESTART EVERYTHING', technicalLabel: 'RESTART PRODUCTION STACK', note: 'Healthy services do not need to be restarted.', correct: false, coach: 'Bold. Also unnecessary. The healthy services did not need a trust fall.', audio: 'recover-restart-all' },
    { id: 'resume_traffic', label: 'SEND ALL TRAFFIC BACK', technicalLabel: 'RESUME FULL TRAFFIC', note: 'Recovery has not been verified yet.', correct: false, coach: 'Not yet. A green light without evidence is just optimism wearing a dashboard.', audio: 'recover-resume-traffic' },
  ],
  communicate: [
    { id: 'evidence_update', label: 'SEND A SHORT EVIDENCE UPDATE', technicalLabel: 'SEND EVIDENCE-BASED UPDATE', note: 'Include impact, action, proof of recovery, and the next check.', correct: true, coach: 'Clear impact, action, evidence, next check. Beautiful. Nobody had to translate “we are looking into it.”', audio: 'communicate-correct' },
    { id: 'resolved_update', label: 'SAY IT IS RESOLVED NOW', technicalLabel: 'DECLARE INCIDENT RESOLVED', note: 'Recovery is improving, but it has not been verified long enough.', correct: false, coach: 'Recovery is trending. Resolved is a claim, and claims need receipts.', audio: 'communicate-resolved' },
    { id: 'technical_dump', label: 'PASTE ALL THE LOGS', technicalLabel: 'SEND RAW LOG OUTPUT', note: 'Raw evidence is too detailed for a stakeholder update.', correct: false, coach: 'Technically accurate. Practically, you just assigned everyone homework during an incident.', audio: 'communicate-log-dump' },
  ],
}

const difficultySettings: Record<Difficulty, {
  name: string
  audience: string
  description: string
  signals: number
  wrongPenalty: number
  hintPenalty: number
  showTranslations: boolean
  showChoiceNotes: boolean
}> = {
  guided: {
    name: 'GUIDED',
    audience: 'NEW TO INCIDENT RESPONSE',
    description: 'Plain-language translations, full prompts, and no penalty for hints.',
    signals: 2,
    wrongPenalty: 10,
    hintPenalty: 0,
    showTranslations: true,
    showChoiceNotes: true,
  },
  standard: {
    name: 'STANDARD',
    audience: 'SOME TECHNICAL EXPERIENCE',
    description: 'Plain and technical language with normal scoring and support.',
    signals: 2,
    wrongPenalty: 15,
    hintPenalty: 5,
    showTranslations: true,
    showChoiceNotes: true,
  },
  challenge: {
    name: 'CHALLENGE',
    audience: 'EXPERIENCED LEARNER',
    description: 'Technical terms, three required signals, fewer prompts, and stronger penalties.',
    signals: 3,
    wrongPenalty: 20,
    hintPenalty: 10,
    showTranslations: false,
    showChoiceNotes: false,
  },
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
    instruction: 'Click two evidence boxes. Then choose what caused the problem.',
    doNow: 'Click two boxes in Live Metrics or Evidence. Then choose one answer.',
    lookFor: 'Release 3.8.2 changed retries. Inventory is timing out. Traffic is steady.',
    success: 'Signals reads 2 / 2 and the answer cards unlock.',
  },
  contain: {
    objective: 'Stop the problem from spreading',
    instruction: 'Choose the action that immediately stops more failed requests.',
    doNow: 'Choose one safety action. Do not restart or repair everything yet.',
    lookFor: 'The best action stops Checkout from calling the failing Inventory service.',
    success: 'The service map says CONTAINED and retries are blocked.',
  },
  recover: {
    objective: 'Return to the last working version',
    instruction: 'Choose how to remove release 3.8.2 and restore the working version.',
    doNow: 'Choose the recovery action connected to the 09:35 release.',
    lookFor: 'Checkout success rises. Error rate and retry rate fall.',
    success: 'The red and amber health numbers turn green.',
  },
  communicate: {
    objective: 'Tell the team what happened and what comes next',
    instruction: 'Choose the clearest update for the team.',
    doNow: 'Choose the message a manager can understand without reading logs.',
    lookFor: 'It says what broke, what changed, proof of recovery, and the next check.',
    success: 'The team receives one short, complete update.',
  },
  complete: {
    objective: 'Incident stabilized',
    instruction: 'Review your score and badges, then choose Retry to reset the entire mission and improve your response.',
    doNow: 'Review the result, open your attempt data, or choose Retry for a fresh mission.',
    lookFor: 'A stronger retry uses fewer hints, fewer unsupported actions, and faster containment.',
    success: 'The stack is stable and the learning record is stored.',
  },
}

const guideScripts: Record<Phase | 'briefing' | 'tour' | 'dashboard', string> = {
  briefing: 'Welcome to Incident nine forty two. It was a routine morning at Relay Nine Commerce until customer support reported that shoppers could fill their carts but could not complete checkout. Complaints are rising, and the system is repeating failed work faster than the team can explain it. You are the on-call responder. Mara will guide you. Find what started the problem, stop it from spreading, restore the working version, and tell the team what happened. Start by clicking two boxes in Live Metrics or Evidence. When Signals shows two of two, choose one decision card.',
  tour: 'Here is the interface. Start at Live Metrics to see what changed. Then inspect Evidence and the service map to see where the delay began. I will respond after each action. At the bottom, read Do this now, Look for, and You are done when. Those three boxes tell you exactly what to do next.',
  diagnose: 'First task. Click any two metric or evidence boxes. Compare the deployment time, the Inventory timeout, and the retry rate. When Signals shows two of two, choose the original cause.',
  contain: 'Second task. Stop the problem from spreading. Choose the fastest safety action that stops Checkout from sending more requests to the failing Inventory service.',
  recover: 'Third task. Return the system to the last working version. Choose the action connected to release three point eight point two, then check that the red and amber numbers turn green.',
  communicate: 'Final task. Choose the update that a manager can understand without reading raw logs. It should state what broke, what action was taken, how recovery was verified, and when the next check will happen.',
  complete: 'Mission complete. Review your score, badges, time, hints, and unsupported actions. Choose View Attempt Data to inspect the record, or Retry to reset the mission and practice again.',
  dashboard: 'This dashboard shows how each attempt went. Total attempts shows practice volume. Average and best score show performance. Average containment time shows speed. Hints and unsupported actions show where the learner needed support. Use the attempt log to compare runs and identify whether performance is improving.',
}

const guideAudioUrls: Record<string, string> = {
  'briefing-guide': 'https://d8j0ntlcm91z4.cloudfront.net/user_3HSvE6RMaScRO3uyDW0tlY21tA6/hf_20260807_134326_efad7c87-c09d-45e7-8d72-0ae61615f65b.mp3',
  'briefing-guide-challenge': 'https://d8j0ntlcm91z4.cloudfront.net/user_3HSvE6RMaScRO3uyDW0tlY21tA6/hf_20260807_134327_15d49917-dccb-4dbd-9c24-501f0b281e64.mp3',
  'tour-guide': 'https://d8j0ntlcm91z4.cloudfront.net/user_3HSvE6RMaScRO3uyDW0tlY21tA6/hf_20260807_130313_6eb05084-98e3-405a-8f8d-782d3d7656e5.mp3',
  'diagnose-guide': 'https://d8j0ntlcm91z4.cloudfront.net/user_3HSvE6RMaScRO3uyDW0tlY21tA6/hf_20260807_130307_910e2aed-c2e4-4469-9d64-a7fd8970d77d.mp3',
  'diagnose-guide-challenge': 'https://d8j0ntlcm91z4.cloudfront.net/user_3HSvE6RMaScRO3uyDW0tlY21tA6/hf_20260807_131215_3f9164c0-ad58-488e-b19a-e613007a6b3e.mp3',
  'contain-guide': 'https://d8j0ntlcm91z4.cloudfront.net/user_3HSvE6RMaScRO3uyDW0tlY21tA6/hf_20260807_130303_d2f2375d-1447-4a91-a2b5-373572bf7b4c.mp3',
  'recover-guide': 'https://d8j0ntlcm91z4.cloudfront.net/user_3HSvE6RMaScRO3uyDW0tlY21tA6/hf_20260807_130305_33b38b38-7611-4e07-b0ea-c31e5cef79ad.mp3',
  'communicate-guide': 'https://d8j0ntlcm91z4.cloudfront.net/user_3HSvE6RMaScRO3uyDW0tlY21tA6/hf_20260807_130310_44b326f7-1403-42d1-9541-d01f5d468759.mp3',
  'complete-guide': 'https://d8j0ntlcm91z4.cloudfront.net/user_3HSvE6RMaScRO3uyDW0tlY21tA6/hf_20260807_130311_56117ace-ecc8-4f74-95c8-2542376bf445.mp3',
  'dashboard-guide': 'https://d8j0ntlcm91z4.cloudfront.net/user_3HSvE6RMaScRO3uyDW0tlY21tA6/hf_20260807_130309_1897d8ff-58e2-4e00-a02b-8232a21eccb1.mp3',
  'intro-challenge': 'https://d8j0ntlcm91z4.cloudfront.net/user_3HSvE6RMaScRO3uyDW0tlY21tA6/hf_20260807_131214_920659ff-c532-4a65-bcc5-214dace2ca8c.mp3',
}

const phaseTranslations: Record<Exclude<Phase, 'complete'>, { plain: string; technical: string }> = {
  diagnose: {
    plain: 'A support service is slow, and Checkout keeps calling it.',
    technical: 'Inventory dependency timeout plus retry amplification',
  },
  contain: {
    plain: 'Temporarily stop calls to the failing service.',
    technical: 'Open the circuit breaker',
  },
  recover: {
    plain: 'Return to the last version that worked.',
    technical: 'Roll back release v3.8.2',
  },
  communicate: {
    plain: 'Tell the team what happened, what changed, and what comes next.',
    technical: 'Send an incident update with recovery evidence',
  },
}

function shuffleChoices(choices: Choice[]) {
  const shuffled = [...choices]
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1))
    ;[shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]]
  }
  return shuffled
}

function NarrationButton({ text, audioKey, label = 'LISTEN TO GUIDE', onCaptionChange }: { text: string; audioKey: string; label?: string; onCaptionChange?: (caption: string | null) => void }) {
  const [playing, setPlaying] = useState(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null)

  const stop = () => {
    audioRef.current?.pause()
    audioRef.current = null
    if ('speechSynthesis' in window) window.speechSynthesis.cancel()
    utteranceRef.current = null
    setPlaying(false)
    onCaptionChange?.(null)
  }

  useEffect(() => stop, [])

  const playFallback = () => {
    if (!('speechSynthesis' in window)) {
      setPlaying(false)
      return
    }
    const utterance = new SpeechSynthesisUtterance(text)
    const voices = window.speechSynthesis.getVoices()
    utterance.voice = voices.find((voice) => /english/i.test(voice.name) && /male|daniel|alex|aaron/i.test(voice.name))
      ?? voices.find((voice) => voice.lang.startsWith('en'))
      ?? null
    utterance.rate = 1.02
    utterance.pitch = 0.96
    utterance.onend = stop
    utterance.onerror = stop
    utteranceRef.current = utterance
    window.speechSynthesis.speak(utterance)
  }

  const toggle = () => {
    if (playing) {
      stop()
      return
    }
    setPlaying(true)
    onCaptionChange?.(text)
    const audio = new Audio(guideAudioUrls[audioKey] ?? `/audio/${audioKey}.mp3`)
    audioRef.current = audio
    audio.onended = stop
    audio.onerror = playFallback
    audio.play().catch(playFallback)
  }

  return (
    <button className={`narration-button ${playing ? 'playing' : ''}`} onClick={toggle} aria-pressed={playing}>
      <span aria-hidden="true">{playing ? '■' : '▶'}</span>
      <strong>{playing ? 'STOP NARRATION' : label}</strong>
    </button>
  )
}

function CaptionOverlay({ text, enabled, onClose }: { text: string | null; enabled: boolean; onClose: () => void }) {
  if (!enabled || !text) return null
  return (
    <aside className="caption-overlay" role="status" aria-live="polite" aria-label="Live captions">
      <div className="caption-label"><strong>CC</strong><span>LIVE CAPTIONS</span></div>
      <p>{text}</p>
      <button onClick={onClose} aria-label="Close current caption">×</button>
    </aside>
  )
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
    { id: 'web', icon: '▣', label: 'WEB APP', x: 14, y: 42, status: 'healthy' },
    { id: 'gateway', icon: '⇄', label: 'API GATEWAY', x: 28, y: 42, status: 'healthy' },
    { id: 'checkout', icon: '◇', label: 'CHECKOUT API', x: 49, y: 22, status: contained ? 'warn' : 'critical' },
    { id: 'inventory', icon: '▤', label: 'INVENTORY', x: 70, y: 22, status: recovered ? 'healthy' : contained ? 'isolated' : 'critical' },
    { id: 'queue', icon: '≋', label: 'MESSAGE QUEUE', x: 49, y: 64, status: contained ? 'warn' : 'critical' },
    { id: 'db', icon: '◉', label: 'PRIMARY DB', x: 70, y: 64, status: 'healthy' },
    { id: 'replica', icon: '◎', label: 'REPLICA', x: 86, y: 64, status: 'healthy' },
  ]

  return (
    <div className="topology" aria-label="Interactive service topology showing a retry-driven failure between Checkout API and Inventory Service">
      <div className="topology-floor" aria-hidden="true" />
      <div className={`failure-orbit ${contained ? 'contained' : ''} ${recovered ? 'recovered' : ''}`} aria-hidden="true"><i /><i /></div>
      <svg className="paths" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        <path className="path healthy" d="M14 46 L28 46" />
        <path className="path healthy" d="M36 43 L48 28" />
        <path className={`path ${recovered ? 'healthy' : contained ? 'isolated' : 'critical'}`} d="M57 26 L70 26" />
        <path className={`path retry ${contained ? 'paused' : ''}`} d="M70 30 C62 38 62 18 56 23" />
        <path className={`path ${contained ? 'warn' : 'critical'}`} d="M52 31 L52 63" />
        <path className="path healthy" d="M58 68 L70 68" />
        <path className="path healthy" d="M78 68 L86 68" />
      </svg>
      <div className={`data-packet packet-one ${contained ? 'paused' : ''}`} aria-hidden="true" />
      <div className={`data-packet packet-two ${contained ? 'paused' : ''}`} aria-hidden="true" />
      {services.map((service) => (
        <div
          className={`service-node ${service.status}`}
          style={{ left: `${service.x}%`, top: `${service.y}%` }}
          key={service.id}
        >
          <span className="node-light" />
          <span className="node-icon" aria-hidden="true">{service.icon}</span>
          <span className="node-copy"><strong>{service.label}</strong><small>{service.status === 'critical' ? 'FAILING' : service.status === 'isolated' ? 'CIRCUIT OPEN' : service.status === 'warn' ? 'RECOVERING' : 'HEALTHY'}</small></span>
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

function CoachPanel({ line, speaking, onReplay, captionsEnabled }: { line: string; speaking: boolean; onReplay: () => void; captionsEnabled: boolean }) {
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
          <span className={`cc ${captionsEnabled ? 'active' : ''}`} aria-label={captionsEnabled ? 'Captions enabled' : 'Captions disabled'}>CC</span>
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
  const [activeCaption, setActiveCaption] = useState<string | null>(null)
  const [captionsEnabled, setCaptionsEnabled] = useState(() => localStorage.getItem('incident-0942-captions') !== 'off')
  const actorId = useMemo(() => getActorId(), [])

  useEffect(() => {
    localStorage.setItem('incident-0942-captions', captionsEnabled ? 'on' : 'off')
    if (!captionsEnabled) setActiveCaption(null)
  }, [captionsEnabled])

  useEffect(() => {
    fetch(`/api/dashboard/summary?actor_id=${encodeURIComponent(actorId)}`)
      .then((response) => response.json())
      .then(setSummary)
      .catch(() => setSummary({ error: true }))
  }, [actorId])

  if (!summary) return <div className="loading">Loading attempt history…</div>
  if (summary.error) return <div className="loading">Attempt history is temporarily unavailable.</div>

  const dashboardNarration = `${guideScripts.dashboard} You have ${summary.total_attempts} total attempts. Your average score is ${summary.average_score} percent, and your best score is ${summary.best_score} percent. Average containment time is ${summary.average_time_to_contain_seconds} seconds. You used ${summary.total_hints} hints and made ${summary.total_unsupported_actions} unsupported choices.`

  return (
    <main className="dashboard-page">
      <header className="dashboard-header">
        <div>
          <span className="eyebrow">PROJECT 03 · LIVE LEARNING DATA</span>
          <h1>INCIDENT ATTEMPT HISTORY</h1>
          <p>See whether each practice attempt became faster, more accurate, and more independent.</p>
        </div>
        <div className="dashboard-actions">
          <button className={`captions-toggle ${captionsEnabled ? 'active' : ''}`} onClick={() => setCaptionsEnabled((enabled) => !enabled)} aria-pressed={captionsEnabled}><strong>CC</strong><span>{captionsEnabled ? 'CAPTIONS ON' : 'CAPTIONS OFF'}</span></button>
          <NarrationButton text={dashboardNarration} audioKey="dashboard-guide" label="LISTEN TO DASHBOARD" onCaptionChange={setActiveCaption} />
          <a className="primary-link" href="/training/incident-0942">RUN SIMULATION</a>
        </div>
      </header>
      <CaptionOverlay text={activeCaption} enabled={captionsEnabled} onClose={() => setActiveCaption(null)} />
      <section className="dashboard-guide" aria-label="How to read this dashboard">
        <div className="dashboard-guide-heading"><span>HOW TO READ THIS</span><strong>Use three questions to understand the learner’s progress.</strong></div>
        <article><span>1 · ACCURACY</span><strong>Are average and best scores improving?</strong><p>Higher scores mean the learner chose more supported actions.</p></article>
        <article><span>2 · SPEED</span><strong>Is containment getting faster?</strong><p>Lower containment time means the learner stopped the spread sooner.</p></article>
        <article><span>3 · INDEPENDENCE</span><strong>Are hints and unsupported choices falling?</strong><p>Lower counts mean less guidance was needed.</p></article>
      </section>
      <section className="summary-grid" aria-label="Attempt summary">
        {[
          ['PRACTICE RUNS', summary.total_attempts],
          ['AVERAGE SCORE', `${summary.average_score}%`],
          ['BEST SCORE', `${summary.best_score}%`],
          ['TIME TO STOP SPREAD', `${summary.average_time_to_contain_seconds}s`],
          ['HINTS USED', summary.total_hints],
          ['WRONG CHOICES', summary.total_unsupported_actions],
        ].map(([label, value]) => (
          <article className="summary-card" key={label}>
            <span>{label}</span><strong>{value}</strong>
          </article>
        ))}
      </section>
      <section className="attempt-table-wrap">
        <div className="section-heading"><span>COMPARE EACH PRACTICE RUN</span><span>{summary.attempts.length} RECENT</span></div>
        {summary.attempts.length === 0 ? (
          <div className="empty-state">Complete the simulation to create your first tracked attempt.</div>
        ) : (
          <div className="attempt-table" role="table">
            <div className="attempt-row table-head" role="row">
              <span>STARTED</span><span>OUTCOME</span><span>SCORE</span><span>HINTS</span><span>TIME TO STOP SPREAD</span>
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
  const [captionsEnabled, setCaptionsEnabled] = useState(() => localStorage.getItem('incident-0942-captions') !== 'off')
  const [activeCaption, setActiveCaption] = useState<string | null>(null)
  const [activeFocus, setActiveFocus] = useState<'briefing' | 'metrics' | 'evidence' | 'topology' | 'decisions' | null>(null)
  const [activeAudioKey, setActiveAudioKey] = useState<string | null>(null)
  const [textSize, setTextSize] = useState<TextSize>(() => (localStorage.getItem('incident-0942-text-size') as TextSize) || 'standard')
  const [difficulty, setDifficulty] = useState<Difficulty>(() => (localStorage.getItem('incident-0942-difficulty') as Difficulty) || 'guided')
  const [phase, setPhase] = useState<Phase>('diagnose')
  const [score, setScore] = useState(0)
  const [streak, setStreak] = useState(0)
  const [reward, setReward] = useState<string | null>(null)
  const [wrongActions, setWrongActions] = useState(0)
  const [hintCount, setHintCount] = useState(0)
  const [selectedEvidence, setSelectedEvidence] = useState<string[]>([])
  const [choiceSets] = useState<Record<Exclude<Phase, 'complete'>, Choice[]>>(() => ({
    diagnose: shuffleChoices(phaseChoices.diagnose),
    contain: shuffleChoices(phaseChoices.contain),
    recover: shuffleChoices(phaseChoices.recover),
    communicate: shuffleChoices(phaseChoices.communicate),
  }))
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
  const difficultyConfig = difficultySettings[difficulty]

  useEffect(() => {
    if (!missionStarted) return
    let active = true
    startSession(actorId)
      .then((id) => {
        if (!active) return
        setAttemptId(id)
        setTrackingStatus('tracked')
        trackEvent(actorId, id, { verb: 'launched', event: 'simulation_launched', phase: 'diagnose', response: difficulty }).catch(() => setTrackingStatus('offline'))
      })
      .catch(() => setTrackingStatus('offline'))
    return () => { active = false }
  }, [actorId, difficulty, missionStarted])

  useEffect(() => {
    if (!missionStarted) return
    const timer = window.setInterval(() => setElapsed((Date.now() - startedAt.current) / 1000), 1000)
    return () => window.clearInterval(timer)
  }, [missionStarted])

  useEffect(() => {
    localStorage.setItem('incident-0942-text-size', textSize)
  }, [textSize])

  useEffect(() => {
    localStorage.setItem('incident-0942-difficulty', difficulty)
  }, [difficulty])

  useEffect(() => {
    localStorage.setItem('incident-0942-captions', captionsEnabled ? 'on' : 'off')
    if (!captionsEnabled) setActiveCaption(null)
  }, [captionsEnabled])

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
    if ('speechSynthesis' in window) window.speechSynthesis.cancel()
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
      title: `First step: click ${difficultyConfig.signals} evidence boxes`,
      detail: `Click any ${difficultyConfig.signals} boxes in Live Metrics or Evidence. When Signals shows ${difficultyConfig.signals} / ${difficultyConfig.signals}, scroll to the answer cards and choose where the failure began.`,
    })
    const introLine = difficulty === 'challenge'
      ? 'Challenge mode selected. Checkout success is collapsing, traffic is steady, and version 3.8.2 changed retry behavior. Inspect three signals before you make the first call. No training wheels, but the logs are still legally required to tell the truth.'
      : 'You are on call. Checkout success is collapsing, traffic is steady, and version 3.8.2 changed retry behavior. Inspect two signals before you make the first call.'
    speak(introLine, difficulty === 'challenge' ? 'intro-challenge' : 'intro')
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
    setActiveCaption(line)
    setActiveAudioKey(audioKey)
    setActiveFocus(audioKey.startsWith('metric-')
      ? 'metrics'
      : audioKey.startsWith('evidence-') || audioKey === 'intro' || audioKey === 'intro-challenge'
        ? 'evidence'
        : audioKey.includes('contain') || audioKey.includes('recover')
          ? 'topology'
          : 'decisions')
    currentAudio.current?.pause()
    if (speakingTimer.current) window.clearTimeout(speakingTimer.current)

    if ('speechSynthesis' in window) window.speechSynthesis.cancel()
    const audio = new Audio(guideAudioUrls[audioKey] ?? `/audio/${audioKey}.mp3`)
    currentAudio.current = audio
    setSpeaking(true)
    const finish = () => {
      if (currentAudio.current === audio) {
        setSpeaking(false)
        setActiveCaption(null)
        setActiveFocus(null)
        setActiveAudioKey(null)
      }
    }
    const playFallback = () => {
      const utterance = new SpeechSynthesisUtterance(line)
      const voices = window.speechSynthesis.getVoices()
      utterance.voice = voices.find((voice) => /english/i.test(voice.name) && /male|daniel|alex|aaron/i.test(voice.name))
        ?? voices.find((voice) => voice.lang.startsWith('en'))
        ?? null
      utterance.rate = 1.02
      utterance.pitch = 0.96
      utterance.onend = finish
      utterance.onerror = finish
      window.speechSynthesis.speak(utterance)
    }
    audio.onended = finish
    audio.onerror = playFallback
    audio.play().catch(playFallback)
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
      tone: nextEvidenceCount >= difficultyConfig.signals ? 'success' : 'info',
      title: nextEvidenceCount >= difficultyConfig.signals ? 'Answers unlocked' : 'Signal captured',
      detail: nextEvidenceCount >= difficultyConfig.signals
        ? `Signals now shows ${difficultyConfig.signals} / ${difficultyConfig.signals}. Scroll to the answer cards and choose where the failure began.`
        : `Signals now shows ${nextEvidenceCount} / ${difficultyConfig.signals}. Click ${difficultyConfig.signals - nextEvidenceCount} more box${difficultyConfig.signals - nextEvidenceCount === 1 ? '' : 'es'} to unlock the answers.`,
    })
    sendEvent({ verb: 'experienced', event: `evidence_${id}`, phase, objectId: `incident-0942/evidence/${id}` })
  }

  const requestHint = () => {
    setHintCount((count) => count + 1)
    showReward(difficultyConfig.hintPenalty === 0 ? 'HINT USED · NO PENALTY' : `HINT USED · INTEGRITY -${difficultyConfig.hintPenalty}`)
    const hints: Record<Exclude<Phase, 'complete'>, { line: string; audio: string }> = {
      diagnose: { line: 'Look for the number growing faster than traffic. The retries are being very loud about it.', audio: 'hint-diagnose' },
      contain: { line: 'Before fixing the release, stop feeding the failing dependency. It has had enough.', audio: 'hint-contain' },
      recover: { line: 'The bad behavior arrived at 09:35. Send that deployment back where it came from.', audio: 'hint-recover' },
      communicate: { line: 'Impact, action, evidence, next checkpoint. Four things. No novella.', audio: 'hint-communicate' },
    }
    if (phase !== 'complete') speak(hints[phase].line, hints[phase].audio)
    if (phase !== 'complete') {
      setFeedback({ tone: 'info', title: 'Coach hint', detail: `${hints[phase].line} ${difficultyConfig.hintPenalty === 0 ? 'Hints do not reduce integrity in Guided mode.' : `This hint costs ${difficultyConfig.hintPenalty} integrity points.`}` })
    }
    sendEvent({ verb: 'interacted', event: 'hint_requested', phase })
  }

  const choose = (choice: Choice) => {
    sendEvent({ verb: 'answered', event: choice.correct ? 'supported_action' : 'unsupported_action', phase, response: choice.id, success: choice.correct, objectId: `incident-0942/decision/${phase}` })
    speak(choice.coach, choice.audio)
    if (!choice.correct) {
      setWrongActions((count) => count + 1)
      setStreak(0)
      showReward(`UNSUPPORTED ACTION · INTEGRITY -${difficultyConfig.wrongPenalty}`)
      if (musicEnabled) playUiTone('warning')
      setFeedback({
        tone: 'warning',
        title: `Unsupported action: integrity -${difficultyConfig.wrongPenalty}`,
        detail: difficulty === 'challenge'
          ? 'That choice does not complete this task. Recheck the evidence and choose again. The mission continues.'
          : 'That choice does not complete this task. Read Look for and You are done when, then choose again. The mission continues.',
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

  const currentChoices = phase === 'complete' ? [] : choiceSets[phase]
  const diagnosisReady = phase !== 'diagnose' || selectedEvidence.length >= difficultyConfig.signals
  const integrity = Math.max(0, 100 - wrongActions * difficultyConfig.wrongPenalty - hintCount * difficultyConfig.hintPenalty)
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

  const currentDoNow = phase === 'diagnose' && selectedEvidence.length < difficultyConfig.signals
    ? `Click ${difficultyConfig.signals - selectedEvidence.length} more box${difficultyConfig.signals - selectedEvidence.length === 1 ? '' : 'es'}. Then choose one answer.`
    : phase === 'diagnose'
      ? `Signals reads ${difficultyConfig.signals} / ${difficultyConfig.signals}. Choose one answer below.`
      : phaseGuidance[phase].doNow

  const currentInstruction = phase === 'diagnose'
    ? `Click ${difficultyConfig.signals} evidence boxes. Then choose what caused the problem.`
    : phaseGuidance[phase].instruction

  const stepNarration = phase === 'diagnose'
    ? `First task. Click any ${difficultyConfig.signals} metric or evidence boxes. Compare the deployment time, the Inventory timeout, and the retry rate. When Signals shows ${difficultyConfig.signals} of ${difficultyConfig.signals}, choose the original cause.`
    : guideScripts[phase]
  const briefingNarration = difficulty === 'challenge'
    ? 'Welcome to Incident nine forty two. Customer support reports that shoppers can fill their carts but cannot complete checkout. Complaints are rising, and failed work is multiplying. You are the on-call responder in Challenge mode. Inspect three metrics or evidence cards before making the first decision. Use the evidence to find the cause, contain the spread, recover the working release, and update the team.'
    : guideScripts.briefing

  const diagnosisNeedsEvidence = phase === 'diagnose' && !diagnosisReady
  const nextFocus = phase === 'complete' ? null : diagnosisNeedsEvidence ? 'evidence' : 'decisions'
  const liveStory: Record<Phase, { source: string; update: string; role: string }> = {
    diagnose: {
      source: 'CUSTOMER SUPPORT',
      update: 'Shoppers can fill their carts, but checkout is failing. Complaints are increasing now.',
      role: `Find where the failure began. Inspect ${difficultyConfig.signals} signals before choosing a cause.`,
    },
    contain: {
      source: 'INCIDENT LEAD',
      update: 'The team found the failing dependency, but repeated requests are still increasing the impact.',
      role: 'Stop new requests from reaching the failing service before the queue grows further.',
    },
    recover: {
      source: 'RELEASE MANAGER',
      update: 'The spread is contained. Customers still need the last known working checkout behavior restored.',
      role: 'Use the change evidence to recover safely, then confirm the health signals turn green.',
    },
    communicate: {
      source: 'INCIDENT LEAD',
      update: 'Checkout is recovering. Leaders and support teams need one clear update they can act on.',
      role: 'Explain the impact, action, recovery proof, and next checkpoint in plain language.',
    },
    complete: {
      source: 'RELAY NINE STATUS',
      update: 'Checkout is stable and the customer-impacting incident is resolved.',
      role: 'Review your result, then retry to improve speed, accuracy, and independence.',
    },
  }
  const setGuideCaption = (caption: string | null, focus: typeof activeFocus) => {
    setActiveCaption(caption)
    setActiveFocus(caption ? focus : null)
  }

  return (
    <main className="simulation-shell" data-text-size={textSize}>
      {briefingOpen && (
        <div className="briefing-backdrop" role="presentation">
          <section className="briefing-modal" role="dialog" aria-modal="true" aria-labelledby="briefing-title" aria-describedby="briefing-summary">
            <div className="briefing-status">
              <span><i /> RELAY NINE COMMERCE · SIMULATED SEV-2</span>
              <span>9:42 LOCAL</span>
            </div>
            <div className="briefing-hero">
              <div className="mission-start-cue"><span aria-hidden="true">1</span><div><strong>START HERE · MISSION BRIEF</strong><small>Understand the situation before you inspect the system.</small></div></div>
              <span className="eyebrow">MISSION BRIEFING · INCIDENT 9:42</span>
              <h2 id="briefing-title">CHECKOUT IS FAILING.<br />YOU ARE NOW ON CALL.</h2>
              <p id="briefing-summary">Customers cannot complete checkout. Your job is to find the cause, stop the problem, restore the working version, and update the team.</p>
              <NarrationButton text={briefingNarration} audioKey={difficulty === 'challenge' ? 'briefing-guide-challenge' : 'briefing-guide'} label="LISTEN TO THE BRIEFING" onCaptionChange={(caption) => setGuideCaption(caption, 'briefing')} />
            </div>

            <section className={`scenario-story ${activeFocus === 'briefing' ? 'speaking-focus' : ''}`} aria-label="Incident scenario">
              <div className="scenario-heading"><span>THE SITUATION</span><strong>A normal shopping morning turned into a customer-impacting incident.</strong></div>
              <article><span className="message-avatar support" aria-hidden="true">CS</span><div><strong>CUSTOMER SUPPORT</strong><p>“Shoppers can add items to their carts, but checkout keeps failing. Complaints are increasing.”</p></div></article>
              <article><span className="message-avatar lead" aria-hidden="true">IL</span><div><strong>INCIDENT LEAD</strong><p>“You are primary responder. Follow the evidence, stop the spread, and give us a clear update.”</p></div></article>
            </section>

            <div className="novice-note" role="note">
              <span>START HERE</span>
              <div><strong>No coding or incident-response experience is required.</strong><p>Every technical term is explained. The mission tells you what to click, what to look for, and when each task is complete.</p></div>
            </div>

            <section className="difficulty-selector" aria-labelledby="difficulty-title">
              <div className="difficulty-heading">
                <span>CHOOSE YOUR PATH</span>
                <strong id="difficulty-title">How much guidance do you want?</strong>
              </div>
              <div className="difficulty-options">
                {(Object.entries(difficultySettings) as [Difficulty, typeof difficultySettings[Difficulty]][]).map(([value, setting]) => (
                  <button key={value} className={difficulty === value ? 'active' : ''} onClick={() => setDifficulty(value)} aria-pressed={difficulty === value} disabled={missionStarted}>
                    <span>{value === 'guided' ? 'RECOMMENDED' : setting.audience}</span>
                    <strong>{setting.name}</strong>
                    <p>{setting.description}</p>
                    <small>{setting.signals} signals · {setting.hintPenalty === 0 ? 'free hints' : `${setting.hintPenalty}-point hints`}</small>
                  </button>
                ))}
              </div>
            </section>

            <div className="briefing-grid">
              <article>
                <span className="briefing-number">01</span>
                <div><strong>CLICK {difficultyConfig.signals} BOXES</strong><p>Choose any {difficultyConfig.signals} boxes in Live Metrics or Evidence.</p></div>
              </article>
              <article>
                <span className="briefing-number">02</span>
                <div><strong>CHOOSE ONE ANSWER</strong><p>When Signals reads {difficultyConfig.signals} / {difficultyConfig.signals}, choose the best answer.</p></div>
              </article>
              <article>
                <span className="briefing-number">03</span>
                <div><strong>REPEAT FOUR ROUNDS</strong><p>Wrong answers explain why. You can always try again.</p></div>
              </article>
            </div>

            <details className="outcome-details">
              <summary>WHY THIS MATTERS AT WORK <span>OPTIONAL DETAILS</span></summary>
              <div>
                <strong>Plain language:</strong><p>Use evidence, stop the spread, restore service, and explain the result.</p>
                <strong>Technical outcome:</strong><p>Isolate a dependency failure, stop retry amplification, verify recovery, and send an evidence-based incident update.</p>
              </div>
            </details>

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
              <strong>SAFE TO PRACTICE</strong>
              <span>No live systems are affected. A wrong answer never ends the mission.</span>
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
                <span>BACKGROUND MUSIC</span><strong>{musicEnabled ? 'ON' : 'OFF'}</strong>
              </button>
              <button className={`captions-toggle ${captionsEnabled ? 'active' : ''}`} onClick={() => setCaptionsEnabled((enabled) => !enabled)} aria-pressed={captionsEnabled}><strong>CC</strong><span>{captionsEnabled ? 'CAPTIONS ON' : 'CAPTIONS OFF'}</span></button>
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
              <p>Follow these three areas from top to bottom.</p>
              <NarrationButton text={guideScripts.tour} audioKey="tour-guide" label="LISTEN TO THE INTERFACE TOUR" onCaptionChange={(caption) => setGuideCaption(caption, 'briefing')} />
            </div>
            <div className="interface-map" aria-label="Three interface regions explained">
              <article className="tour-card metrics-tour">
                <span className="tour-index">01</span>
                <div><strong>LOOK</strong><p>Click {difficultyConfig.signals} boxes in Live Metrics or Evidence.</p><small>Red and amber show what needs attention.</small></div>
              </article>
              <article className="tour-card evidence-tour">
                <span className="tour-index">02</span>
                <div><strong>LISTEN</strong><p>Mara explains every box and answer in plain language.</p><small>Use the replay control if you want to hear a line again.</small></div>
              </article>
              <article className="tour-card decision-tour">
                <span className="tour-index">03</span>
                <div><strong>ACT</strong><p>Read Do this now, then choose one answer.</p><small>The answer order changes on every new attempt.</small></div>
              </article>
            </div>
            <div className="tour-footer">
              <button className="secondary-button" onClick={() => { setTourOpen(false); setBriefingOpen(true) }}>BACK TO BRIEF</button>
              <div><span>READY CHECK · {difficultyConfig.name}</span><strong>Click {difficultyConfig.signals} boxes. Wait for {difficultyConfig.signals} / {difficultyConfig.signals}. Choose one answer.</strong></div>
              <button className="begin-button" onClick={beginMission}>START TIMED MISSION <span>▶</span></button>
            </div>
          </section>
        </div>
      )}

      {reward && <div className="reward-pop" role="status"><span>MISSION UPDATE</span><strong>{reward}</strong></div>}
      <CaptionOverlay text={activeCaption} enabled={captionsEnabled} onClose={() => setActiveCaption(null)} />

      <header className="topbar">
        <div className="brand-block">
          <RelayNineLogo compact />
          <span className="incident-mark">9:42</span>
          <div><span className="eyebrow">LIVE TECHNICAL TRAINING</span><h1>STABILIZE THE STACK</h1></div>
        </div>
        <div className="topbar-actions">
          <button className={`utility-button mission-brief-button ${!missionStarted ? 'attention' : ''}`} onClick={() => setBriefingOpen(true)}><span className="attention-icon" aria-hidden="true">ⓘ</span> MISSION BRIEF</button>
          {missionStarted && phase !== 'complete' && <button className="utility-button reset-button" onClick={reset}><span aria-hidden="true">↻</span> RESET MISSION</button>}
          <div className="equipment-console" aria-label="Audio and accessibility equipment">
            <span className="equipment-label">FIELD KIT</span>
            <button className={`speaker-button ${musicEnabled ? 'active' : ''}`} onClick={() => setMusicEnabled((enabled) => !enabled)} aria-label={musicEnabled ? 'Turn background music off' : 'Turn background music on'} title={musicEnabled ? 'Background music on' : 'Background music off'} aria-pressed={musicEnabled}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M4 9v6h4l5 4V5L8 9H4z" />
                {musicEnabled ? <><path d="M16 9c1.2 1.4 1.2 4.6 0 6" /><path d="M18.5 6.5c3.2 3 3.2 8 0 11" /></> : <path d="m16 9 5 6m0-6-5 6" />}
              </svg>
              <span>{musicEnabled ? 'MUSIC ON' : 'MUSIC OFF'}</span>
            </button>
            <div className="inline-text-control" aria-label="Text size">
              {([['compact', 'Small text'], ['standard', 'Standard text'], ['large', 'Large text']] as const).map(([value, accessibleLabel]) => (
                <button key={value} className={`text-${value} ${textSize === value ? 'active' : ''}`} onClick={() => setTextSize(value)} aria-label={accessibleLabel} title={accessibleLabel} aria-pressed={textSize === value}>A</button>
              ))}
            </div>
            <button className={`cc-button ${captionsEnabled ? 'active' : ''}`} onClick={() => setCaptionsEnabled((enabled) => !enabled)} aria-label={captionsEnabled ? 'Turn captions off' : 'Turn captions on'} aria-pressed={captionsEnabled}><strong>CC</strong><span>{captionsEnabled ? 'ON' : 'OFF'}</span></button>
          </div>
          <span className={`tracking-pill ${trackingStatus}`}><i />{trackingStatus === 'tracked' ? 'ATTEMPT TRACKED' : trackingStatus === 'offline' ? 'LOCAL MODE' : 'CONNECTING'}</span>
          <a href="/dashboard"><span aria-hidden="true">▦</span> VIEW ATTEMPTS</a>
        </div>
      </header>

      <section className="live-story-ribbon" aria-label="Current incident story and learner role">
        <div className="story-live-label"><i aria-hidden="true" /><span>LIVE INCIDENT STORY</span></div>
        <div className="story-message">
          <span className="message-avatar support" aria-hidden="true">{liveStory[phase].source.split(' ').map((word) => word[0]).join('').slice(0, 2)}</span>
          <div><strong>{liveStory[phase].source}</strong><p>{liveStory[phase].update}</p></div>
        </div>
        <div className="story-next">
          <span>YOUR NEXT MOVE</span>
          <strong>{liveStory[phase].role}</strong>
        </div>
      </section>

      <section className="mission-hud" aria-label="Mission status">
        <div className="objective-block">
          <span className="eyebrow">ACTIVE OBJECTIVE</span>
          <strong>{phaseGuidance[phase].objective}</strong>
          <p>{currentInstruction}</p>
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
          <div><span>SIGNALS</span><strong>{Math.min(selectedEvidence.length, difficultyConfig.signals)} / {difficultyConfig.signals}</strong></div>
          <div><span>STREAK</span><strong>×{streak}</strong></div>
          <div><span>TIME</span><strong>{formatDuration(elapsed)}</strong></div>
        </div>
        <div className="rank-strip"><span>{difficultyConfig.name} PATH</span><strong>{rank}</strong></div>
      </section>

      <section className={`feedback-banner ${feedback.tone}`} aria-live="polite">
        <span>{feedback.tone === 'success' ? '✓' : feedback.tone === 'warning' ? '!' : '→'}</span>
        <div><strong>{feedback.title}</strong><p>{feedback.detail}</p></div>
      </section>

      {phase !== 'complete' && difficultyConfig.showTranslations && (
        <section className="translation-strip" aria-label="Plain-language technical translation">
          <div><span>IN PLAIN LANGUAGE</span><strong>{phaseTranslations[phase].plain}</strong></div>
          <i aria-hidden="true">→</i>
          <div><span>THE WORKPLACE TERM</span><strong>{phaseTranslations[phase].technical}</strong></div>
        </section>
      )}

      <section className={`metric-strip ${activeFocus === 'metrics' ? 'speaking-focus' : ''}`} aria-label="Live incident metrics">
        {recoveryMetrics.map((metric) => (
          <button className={`metric ${metric.tone} ${speaking && activeAudioKey === metric.audio ? 'spoken-item' : ''}`} key={metric.label} onClick={() => inspectEvidence(metric.label.toLowerCase().replaceAll(' ', '-'), metricCoachLines[metric.label] ?? `${metric.label}: ${metric.detail}.`, metric.audio)}>
            <span>{metric.label}</span><strong>{metric.value}</strong><small>{metric.detail}</small>
          </button>
        ))}
      </section>

      <div className="workspace">
        <aside className={`evidence-panel panel ${activeFocus === 'evidence' ? 'speaking-focus' : activeFocus === null && nextFocus === 'evidence' ? 'attention-panel' : ''}`} aria-current={activeFocus === null && nextFocus === 'evidence' ? 'step' : undefined}>
          <div className="panel-heading"><span>EVIDENCE</span>{activeFocus === null && nextFocus === 'evidence' ? <span className="focus-cue"><i /> NEXT · CLICK A CARD</span> : <span>{selectedEvidence.length} INSPECTED</span>}</div>
          <button className={`evidence-card ${selectedEvidence.includes('deployment') ? 'selected' : ''} ${speaking && activeAudioKey === 'evidence-deployment' ? 'spoken-item' : ''}`} onClick={() => inspectEvidence('deployment', 'Version 3.8.2 landed seven minutes before the incident. Not proof, but the timing is doing a lot of suspicious work.', 'evidence-deployment')}>
            <span>CHANGE HISTORY · WHAT CHANGED?</span><strong>09:35 · v3.8.2</strong><small>Retry policy modified</small>
          </button>
          <button className={`evidence-card ${selectedEvidence.includes('logs') ? 'selected' : ''} ${speaking && activeAudioKey === 'evidence-logs' ? 'spoken-item' : ''}`} onClick={() => inspectEvidence('logs', 'Three immediate attempts for one request. That is not resilience. That is the same problem with a loyalty program.', 'evidence-logs')}>
            <span>ERROR RECORD · WHAT FAILED?</span>
            <code>09:42:11 ERROR inventory timeout</code>
            <code>09:42:11 WARN attempt 3/3</code>
            <code>09:42:12 WARN queue depth 1460</code>
          </button>
          <button className={`evidence-card ${selectedEvidence.includes('trace') ? 'selected' : ''} ${speaking && activeAudioKey === 'evidence-trace' ? 'spoken-item' : ''}`} onClick={() => inspectEvidence('trace', 'Checkout waits 2.6 seconds on Inventory. The database is clean. Please update the suspect list.', 'evidence-trace')}>
            <span>REQUEST PATH · WHERE DID TIME GO?</span>
            <div className="trace"><i style={{ width: '18%' }} /><i className="bad" style={{ width: '64%' }} /><i style={{ width: '12%' }} /></div>
            <small>Checkout → Inventory: 2.6s</small>
          </button>
        </aside>

        <section className={`system-panel panel ${activeFocus === 'topology' ? 'speaking-focus' : ''}`}>
          <div className="panel-heading"><span>SERVICE TOPOLOGY</span><span className={recovered ? 'status-good' : 'status-live'}>{recovered ? 'RECOVERED' : contained ? 'CONTAINED' : 'DEGRADED'}</span></div>
          <ServiceTopology contained={contained} recovered={recovered} />
        </section>

        <CoachPanel line={coachLine} speaking={speaking} onReplay={() => speak(coachLine, coachAudio)} captionsEnabled={captionsEnabled} />
      </div>

      <section className={`decision-panel panel ${activeFocus === 'decisions' ? 'speaking-focus' : activeFocus === null && nextFocus === 'decisions' ? 'attention-panel' : ''}`} aria-current={activeFocus === null && nextFocus === 'decisions' ? 'step' : undefined}>
        {activeFocus === null && nextFocus === 'decisions' && <div className="decision-focus-cue"><span><i /> NEXT STEP</span><strong>Choose one supported action below.</strong></div>}
        <div className="decision-heading">
          <div>
            <span className="eyebrow">{phaseLabels[phase]} {phaseNumber[phase].toString().padStart(2, '0')} / 04</span>
            <h2>{phase === 'diagnose' ? 'WHERE DID THE FAILURE BEGIN?' : phase === 'contain' ? 'WHAT SHOULD YOU DO FIRST?' : phase === 'recover' ? 'HOW DO YOU RECOVER SAFELY?' : phase === 'communicate' ? 'WHAT DOES THE TEAM NEED NOW?' : 'STACK STABILIZED'}</h2>
            <p className="decision-instruction">{currentInstruction}</p>
          </div>
          {phase !== 'complete' && (
            <div className="decision-tools">
              <NarrationButton text={stepNarration} audioKey={phase === 'diagnose' && difficulty === 'challenge' ? 'diagnose-guide-challenge' : `${phase}-guide`} label="LISTEN TO THIS STEP" onCaptionChange={(caption) => setGuideCaption(caption, phase === 'contain' || phase === 'recover' ? 'topology' : 'decisions')} />
              <button className="hint-button" onClick={requestHint}><i aria-hidden="true">?</i> REQUEST HINT <span>{hintCount}</span></button>
            </div>
          )}
        </div>

        {phase !== 'complete' ? (
          <>
            <section className={`task-guide ${difficulty === 'challenge' ? 'challenge' : ''}`} aria-label="Current task instructions">
              <article className="task-now"><span>DO THIS NOW</span><strong>{currentDoNow}</strong></article>
              {difficulty !== 'challenge' && <article className="task-look"><span>LOOK FOR</span><strong>{phaseGuidance[phase].lookFor}</strong></article>}
              {difficulty !== 'challenge' && <article className="task-done"><span>YOU ARE DONE WHEN</span><strong>{phaseGuidance[phase].success}</strong></article>}
            </section>
            {!diagnosisReady && (
              <div className="decision-lock" role="status">
                <span>LOCKED</span>
                <strong>Inspect {difficultyConfig.signals - selectedEvidence.length} more signal{difficultyConfig.signals - selectedEvidence.length === 1 ? '' : 's'} to unlock the answers.</strong>
              </div>
            )}
            <div className="choices">
              {currentChoices.map((choice) => (
                <button className="choice-card" key={choice.id} onClick={() => choose(choice)} disabled={!diagnosisReady}>
                  <span className="choice-index">{String.fromCharCode(65 + currentChoices.indexOf(choice))}</span>
                  <span><strong>{difficulty === 'challenge' ? choice.technicalLabel ?? choice.label : choice.label}</strong>{difficultyConfig.showChoiceNotes && <small>{choice.note}</small>}</span>
                  <i>SELECT →</i>
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
            <NarrationButton text={guideScripts.complete} audioKey="complete-guide" label="LISTEN TO RESULTS" onCaptionChange={(caption) => setGuideCaption(caption, 'decisions')} />
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
