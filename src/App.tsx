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
type TourFocus = 'story' | 'metrics' | 'evidence' | 'topology' | 'coach' | 'decisions'
type ActiveFocus = 'briefing' | 'metrics' | 'evidence' | 'topology' | 'decisions'
type VoiceRole = 'iris' | 'mara'

type Feedback = {
  tone: 'info' | 'success' | 'warning'
  title: string
  detail: string
}

const initialMetrics: Metric[] = [
  { label: 'CHECKOUT ERROR RATE', value: '24.7%', tone: 'critical', detail: 'Customers blocked', audio: 'metric-error-rate' },
  { label: 'CHECKOUT LATENCY P95', value: '1450 MS', tone: 'warn', detail: 'Normal is under 300 ms', audio: 'metric-retry-rate' },
  { label: 'PAYMENT SUCCESS RATE', value: '98.1%', tone: 'healthy', detail: 'Downstream is healthy', audio: 'metric-checkout-success' },
  { label: 'ACTIVE USERS', value: '12.6K', tone: 'neutral', detail: 'Traffic is steady', audio: 'metric-requests' },
]

const phaseChoices: Record<Exclude<Phase, 'complete'>, Choice[]> = {
  diagnose: [
    { id: 'inventory_dependency', label: 'INVENTORY SERVICE FAILED', technicalLabel: 'INVENTORY DEPENDENCY TIMEOUT', note: 'Technical signal: dependency timeout plus repeated requests.', correct: true, coach: 'There it is. Inventory timed out, Checkout multiplied it, and now everybody is invited to the incident.', audio: 'diagnose-correct' },
    { id: 'database_cpu', label: 'THE DATABASE FAILED', technicalLabel: 'PRIMARY DATABASE SATURATION', note: 'This would fit only if the database health was also failing.', correct: false, coach: 'The database appreciates the concern. It is healthy, innocent, and somehow still in the group chat.', audio: 'diagnose-database' },
    { id: 'traffic_spike', label: 'TOO MANY CUSTOMERS ARRIVED', technicalLabel: 'TRAFFIC CAPACITY EVENT', note: 'This would fit only if incoming traffic had increased.', correct: false, coach: 'Traffic is steady. The retries are multiplying like they heard there was free food.', audio: 'diagnose-traffic' },
    { id: 'payment_gateway', label: 'PAYMENT SERVICE FAILED', technicalLabel: 'PAYMENT GATEWAY OUTAGE', note: 'Payment success is still healthy, so this is not the source.', correct: false, coach: 'Payment looks healthy. It is nearby, but nearby is not guilty. We are doing evidence, not vibes.', audio: 'diagnose-traffic' },
  ],
  contain: [
    { id: 'dependency_protection', label: 'STOP CALLS TO INVENTORY', technicalLabel: 'OPEN CIRCUIT BREAKER', note: 'Technical action: open the existing circuit breaker.', correct: true, coach: 'Good. Circuit open. We stopped sending traffic to a service that was already having a terrible morning.', audio: 'contain-correct' },
    { id: 'rollback_first', label: 'ROLL BACK THE RELEASE', technicalLabel: 'ROLL BACK DEPLOYMENT', note: 'Useful next, but it does not stop the retry surge immediately.', correct: false, coach: 'Right instinct, wrong order. Stop the retry storm first, then roll back the release that started all this.', audio: 'contain-rollback-first' },
    { id: 'scale_database', label: 'ADD DATABASE CAPACITY', technicalLabel: 'SCALE PRIMARY DATABASE', note: 'The database is healthy, so this does not address the cause.', correct: false, coach: 'More database, same outage. We just bought the innocent bystander a larger chair.', audio: 'contain-scale-database' },
    { id: 'restart_checkout', label: 'RESTART CHECKOUT SERVICE', technicalLabel: 'RESTART CHECKOUT SERVICE', note: 'A restart may clear symptoms, but it does not stop the retry storm.', correct: false, coach: 'A restart feels productive. It is also how incidents put on a fake mustache and come right back.', audio: 'contain-scale-database' },
  ],
  recover: [
    { id: 'rollback_v382', label: 'RESTORE THE PREVIOUS VERSION', technicalLabel: 'ROLL BACK v3.8.2', note: 'Technical action: roll back release v3.8.2.', correct: true, coach: 'Clean rollback. Nice. Now prove recovery before anyone types resolved with confidence they have not earned.', audio: 'recover-correct' },
    { id: 'restart_all', label: 'RESTART EVERYTHING', technicalLabel: 'RESTART PRODUCTION STACK', note: 'Healthy services do not need to be restarted.', correct: false, coach: 'Bold. Also unnecessary. The healthy services did not need a trust fall.', audio: 'recover-restart-all' },
    { id: 'resume_traffic', label: 'SEND ALL TRAFFIC BACK', technicalLabel: 'RESUME FULL TRAFFIC', note: 'Recovery has not been verified yet.', correct: false, coach: 'Not yet. A green light without evidence is just optimism wearing a dashboard.', audio: 'recover-resume-traffic' },
    { id: 'scale_checkout', label: 'SCALE CHECKOUT SERVICE', technicalLabel: 'SCALE CHECKOUT SERVICE', note: 'More checkout capacity does not remove the bad retry behavior.', correct: false, coach: 'More Checkout pods means more places for the same bad behavior to live. Spacious, but not solved.', audio: 'recover-restart-all' },
  ],
  communicate: [
    { id: 'evidence_update', label: 'SEND A SHORT EVIDENCE UPDATE', technicalLabel: 'SEND EVIDENCE-BASED UPDATE', note: 'Include impact, action, proof of recovery, and the next check.', correct: true, coach: 'Clear impact, action, evidence, next check. Beautiful. Nobody had to translate “we are looking into it.”', audio: 'communicate-correct' },
    { id: 'resolved_update', label: 'SAY IT IS RESOLVED NOW', technicalLabel: 'DECLARE INCIDENT RESOLVED', note: 'Recovery is improving, but it has not been verified long enough.', correct: false, coach: 'Recovery is trending. Resolved is a claim, and claims need receipts.', audio: 'communicate-resolved' },
    { id: 'technical_dump', label: 'PASTE ALL THE LOGS', technicalLabel: 'SEND RAW LOG OUTPUT', note: 'Raw evidence is too detailed for a stakeholder update.', correct: false, coach: 'Technically accurate. Practically, you just assigned everyone homework during an incident.', audio: 'communicate-log-dump' },
    { id: 'send_no_update', label: 'WAIT BEFORE UPDATING', technicalLabel: 'DELAY STAKEHOLDER UPDATE', note: 'Support and leadership need a clear status now.', correct: false, coach: 'Silence is not a comms strategy. It is how Slack becomes a haunted house.', audio: 'communicate-resolved' },
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
  'CHECKOUT ERROR RATE': 'Checkout errors are the red flag. Nearly one in four checkout attempts is failing, which is customer impact, not dashboard decoration.',
  'CHECKOUT LATENCY P95': 'Checkout latency is high. The page is not just slow. It is waiting on a service that is struggling.',
  'PAYMENT SUCCESS RATE': 'Payment success is healthy. That helps us avoid blaming the payment service just because it is near the checkout flow.',
  'ACTIVE USERS': 'Active users are steady. So this does not look like a sudden traffic spike.',
}

const phaseLabels: Record<Phase, string> = {
  diagnose: 'INVESTIGATE',
  contain: 'DIAGNOSE',
  recover: 'STABILIZE',
  communicate: 'VALIDATE',
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
    instruction: 'Click Live Signals or Evidence cards in the right rail. Then choose what caused the problem.',
    doNow: 'Click signals or evidence cards in the right rail. Then choose one answer.',
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
  briefing: 'Welcome to Incident nine forty two. Relay Nine Commerce has a checkout incident. Customers can shop, but many cannot pay. You are the responder. The left rail gives the mission brief and Mara coaching. The center map shows the services. The right rail shows live signals and evidence. The bottom row gives your next decision. Start by clicking signals or evidence. When Signals reaches the target, choose one decision card.',
  tour: 'Here is the interface you will use. Read the left mission brief first so the story is clear. Then scan the right Live Signals panel for the numbers that changed. Next, click Evidence cards in the right rail and use the center service map to see how Checkout connects to Inventory, Payment, Cart, and the queue. Mara will glow the exact area she is explaining. When Signals reaches the target, move to the bottom decision cards and choose the action best supported by evidence.',
  diagnose: 'First task. Investigate the right rail. Click the live signals or evidence cards until Signals reaches the target. Compare the Checkout error rate, latency, release time, Inventory timeout, and steady active users. Then choose where the failure began.',
  contain: 'Second task. Use the center service map. Checkout is multiplying calls to Inventory. Choose the action that stops the spread before you repair the release.',
  recover: 'Third task. Use the change evidence and the center service map. Return Checkout to the last working version, then check that error rate and latency recover.',
  communicate: 'Final task. Use the bottom decision cards. Choose the update a manager can understand without reading raw logs. It should include impact, action, proof of recovery, and the next check.',
  complete: 'Mission complete. Review your score, badges, time, hints, and unsupported actions. Choose View Attempt Data to inspect the record, or Retry to reset the mission and practice again.',
  dashboard: 'This dashboard shows how each attempt went. Total attempts shows practice volume. Average and best score show performance. Average containment time shows speed. Hints and unsupported actions show where the learner needed support. Use the attempt log to compare runs and identify whether performance is improving.',
}

const tourSteps: { focus: TourFocus; caption: string }[] = [
  { focus: 'story', caption: 'Start with the left mission brief. This gives you the story before the numbers.' },
  { focus: 'metrics', caption: 'Next, scan Live Signals on the right. Red means customer impact. Amber means the system is getting worse.' },
  { focus: 'evidence', caption: 'Then click Evidence cards on the right. These are the clues that explain why the signals changed.' },
  { focus: 'topology', caption: 'Use the center service map to see how Checkout connects to Inventory, Payment, Cart, and the queue.' },
  { focus: 'coach', caption: 'Mara explains the technical signal in plain language and tells you exactly what to do next.' },
  { focus: 'decisions', caption: 'When Signals reaches the target, use the bottom decision cards. Pick the action best supported by evidence.' },
]

const mapTourFocusToActiveFocus = (focus: TourFocus): ActiveFocus => {
  if (focus === 'metrics') return 'metrics'
  if (focus === 'evidence') return 'evidence'
  if (focus === 'topology') return 'topology'
  if (focus === 'decisions') return 'decisions'
  return 'briefing'
}

const guidedPhaseIntros: Record<Phase, string> = {
  diagnose: 'Step one. Investigate means find where the problem started. Use the right rail to click signals and evidence until Signals reaches the target, then choose the cause.',
  contain: 'Nice. Step two is diagnosis and containment. That means stop the problem from spreading. Look at the center service map, then choose the action that blocks more failed requests.',
  recover: 'Good. Step three is stabilization. That means return the system to the last working version. Use the change history and choose the safest recovery action.',
  communicate: 'Great. Step four is validation. That means tell the team what happened, what you did, what proves recovery, and what you will check next.',
  complete: 'Mission complete. Review your result, then use Retry if you want a fresh run with a new answer order.',
}

const guideAudioUrls: Record<string, string> = {
  'briefing-guide': 'https://d8j0ntlcm91z4.cloudfront.net/user_3HSvE6RMaScRO3uyDW0tlY21tA6/hf_20260807_134326_efad7c87-c09d-45e7-8d72-0ae61615f65b.mp3',
  'briefing-guide-challenge': 'https://d8j0ntlcm91z4.cloudfront.net/user_3HSvE6RMaScRO3uyDW0tlY21tA6/hf_20260807_134327_15d49917-dccb-4dbd-9c24-501f0b281e64.mp3',
  'diagnose-guide': 'https://d8j0ntlcm91z4.cloudfront.net/user_3HSvE6RMaScRO3uyDW0tlY21tA6/hf_20260807_130307_910e2aed-c2e4-4469-9d64-a7fd8970d77d.mp3',
  'diagnose-guide-challenge': 'https://d8j0ntlcm91z4.cloudfront.net/user_3HSvE6RMaScRO3uyDW0tlY21tA6/hf_20260807_131215_3f9164c0-ad58-488e-b19a-e613007a6b3e.mp3',
  'contain-guide': 'https://d8j0ntlcm91z4.cloudfront.net/user_3HSvE6RMaScRO3uyDW0tlY21tA6/hf_20260807_130303_d2f2375d-1447-4a91-a2b5-373572bf7b4c.mp3',
  'recover-guide': 'https://d8j0ntlcm91z4.cloudfront.net/user_3HSvE6RMaScRO3uyDW0tlY21tA6/hf_20260807_130305_33b38b38-7611-4e07-b0ea-c31e5cef79ad.mp3',
  'communicate-guide': 'https://d8j0ntlcm91z4.cloudfront.net/user_3HSvE6RMaScRO3uyDW0tlY21tA6/hf_20260807_130310_44b326f7-1403-42d1-9541-d01f5d468759.mp3',
  'complete-guide': 'https://d8j0ntlcm91z4.cloudfront.net/user_3HSvE6RMaScRO3uyDW0tlY21tA6/hf_20260807_130311_56117ace-ecc8-4f74-95c8-2542376bf445.mp3',
  'dashboard-guide': 'https://d8j0ntlcm91z4.cloudfront.net/user_3HSvE6RMaScRO3uyDW0tlY21tA6/hf_20260807_130309_1897d8ff-58e2-4e00-a02b-8232a21eccb1.mp3',
  'intro-challenge': 'https://d8j0ntlcm91z4.cloudfront.net/user_3HSvE6RMaScRO3uyDW0tlY21tA6/hf_20260807_131214_920659ff-c532-4a65-bcc5-214dace2ca8c.mp3',
}

function selectNarrationVoice(role: VoiceRole) {
  if (!('speechSynthesis' in window)) return null
  const voices = window.speechSynthesis.getVoices()
  if (role === 'iris') {
    return voices.find((voice) => /iris/i.test(voice.name))
      ?? voices.find((voice) => /english/i.test(voice.name) && /female|samantha|victoria|karen|serena|ava/i.test(voice.name))
      ?? voices.find((voice) => voice.lang.startsWith('en'))
      ?? null
  }
  return voices.find((voice) => /mara/i.test(voice.name))
    ?? voices.find((voice) => /english/i.test(voice.name) && /female|samantha|victoria|karen|serena|ava/i.test(voice.name))
    ?? voices.find((voice) => voice.lang.startsWith('en'))
    ?? null
}

function getNarrationSource(audioKey: string, role: VoiceRole) {
  if (role === 'iris') return guideAudioUrls[audioKey] ?? null
  return `/audio/${audioKey}.mp3`
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

function shuffleChoicesWithMovingAnswer(choices: Choice[], avoidCorrectIndex?: number) {
  const correctChoice = choices.find((choice) => choice.correct)
  const distractors = shuffleChoices(choices.filter((choice) => !choice.correct))
  if (!correctChoice) return shuffleChoices(choices)

  const positions = choices.map((_, index) => index).filter((index) => index !== avoidCorrectIndex)
  const correctIndex = positions[Math.floor(Math.random() * positions.length)] ?? 0
  const shuffled = [...distractors]
  shuffled.splice(correctIndex, 0, correctChoice)
  return shuffled
}

function createChoiceSets() {
  let previousCorrectIndex: number | undefined
  return (Object.keys(phaseChoices) as Exclude<Phase, 'complete'>[]).reduce((sets, phaseKey) => {
    const shuffled = shuffleChoicesWithMovingAnswer(phaseChoices[phaseKey], previousCorrectIndex)
    previousCorrectIndex = shuffled.findIndex((choice) => choice.correct)
    sets[phaseKey] = shuffled
    return sets
  }, {} as Record<Exclude<Phase, 'complete'>, Choice[]>)
}

function NarrationButton({ text, audioKey, label = 'LISTEN TO GUIDE', role = 'iris', onCaptionChange, onPlayingChange }: { text: string; audioKey: string; label?: string; role?: VoiceRole; onCaptionChange?: (caption: string | null) => void; onPlayingChange?: (playing: boolean) => void }) {
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
    onPlayingChange?.(false)
  }

  useEffect(() => stop, [])

  const playFallback = () => {
    if (!('speechSynthesis' in window)) {
      setPlaying(false)
      return
    }
    const utterance = new SpeechSynthesisUtterance(text)
    utterance.voice = selectNarrationVoice(role)
    utterance.rate = 1.02
    utterance.pitch = role === 'iris' ? 1.02 : 0.96
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
    onPlayingChange?.(true)
    const audioUrl = getNarrationSource(audioKey, role)
    if (!audioUrl) {
      playFallback()
      return
    }
    const audio = new Audio(audioUrl)
    audioRef.current = audio
    audio.onended = stop
    audio.onerror = playFallback
    audio.play().catch(playFallback)
  }

  return (
    <button className={`narration-button ${playing ? 'playing' : ''}`} onClick={toggle} aria-pressed={playing}>
      <span aria-hidden="true">{playing ? '■' : '▶'}</span>
      <strong>{playing ? 'STOP NARRATION' : label}</strong>
      <small>{role === 'iris' ? 'IRIS' : 'MARA'}</small>
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
    { id: 'web', icon: '◎', label: 'WEB FRONT END', x: 50, y: 16, status: 'healthy' },
    { id: 'checkout', icon: '◇', label: 'CHECKOUT SERVICE', x: 24, y: 38, status: contained ? 'warn' : 'critical' },
    { id: 'cart', icon: '◇', label: 'CART SERVICE', x: 50, y: 38, status: 'healthy' },
    { id: 'inventory', icon: '◇', label: 'INVENTORY SERVICE', x: 76, y: 38, status: recovered ? 'healthy' : contained ? 'isolated' : 'critical' },
    { id: 'user', icon: '◇', label: 'USER SERVICE', x: 24, y: 58, status: 'healthy' },
    { id: 'order', icon: '◇', label: 'ORDER SERVICE', x: 50, y: 58, status: contained ? 'warn' : 'healthy' },
    { id: 'payment', icon: '◇', label: 'PAYMENT SERVICE', x: 76, y: 58, status: 'healthy' },
    { id: 'redis', icon: '≋', label: 'REDIS CACHE', x: 24, y: 78, status: 'healthy' },
    { id: 'ordersdb', icon: '▤', label: 'ORDERS DATABASE', x: 50, y: 78, status: 'healthy' },
    { id: 'queue', icon: '▣', label: 'MESSAGE QUEUE', x: 76, y: 78, status: contained ? 'warn' : 'healthy' },
  ]

  return (
    <div className="topology" aria-label="Interactive service topology showing a retry-driven failure between Checkout API and Inventory Service">
      <div className="topology-floor" aria-hidden="true" />
      <div className={`failure-orbit ${contained ? 'contained' : ''} ${recovered ? 'recovered' : ''}`} aria-hidden="true"><i /><i /></div>
      <svg className="paths" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        <path className="path healthy" d="M50 22 L24 33" />
        <path className="path healthy" d="M50 22 L50 33" />
        <path className="path healthy" d="M50 22 L76 33" />
        <path className={`path ${contained || recovered ? 'isolated' : 'critical'}`} d="M32 39 L68 39" />
        <path className={`path retry ${contained ? 'paused' : ''}`} d="M74 41 C60 49 42 46 27 42" />
        <path className="path healthy" d="M24 44 L24 53" />
        <path className={`path ${contained ? 'warn' : 'critical'}`} d="M50 44 L50 53" />
        <path className="path healthy" d="M76 44 L76 53" />
        <path className="path healthy" d="M24 64 L24 73" />
        <path className="path healthy" d="M50 64 L50 73" />
        <path className="path healthy" d="M76 64 L76 73" />
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

function TourInterfacePreview({ focus, signals }: { focus: TourFocus; signals: number }) {
  const previewMetrics = initialMetrics.slice(0, 4)
  const tourChoices = useMemo(() => shuffleChoicesWithMovingAnswer(phaseChoices.diagnose, 0), [])

  return (
    <section className="tour-interface-preview" aria-label="Guided preview of the training interface">
      <div className={`tour-preview-story ${focus === 'story' ? 'tour-glow active' : ''}`}>
        <span>LIVE INCIDENT STORY</span>
        <strong>Checkout is failing. Your job is to follow the evidence.</strong>
        <small>Start here so the numbers have context.</small>
      </div>

      <div className={`tour-preview-metrics ${focus === 'metrics' ? 'tour-glow active' : ''}`}>
        <div className="tour-preview-label"><span>1</span><strong>LIVE METRICS</strong><small>What changed?</small></div>
        {previewMetrics.map((metric) => (
          <article className={`preview-metric ${metric.tone}`} key={metric.label}>
            <span>{metric.label}</span>
            <strong>{metric.value}</strong>
            <small>{metric.detail}</small>
          </article>
        ))}
      </div>

      <div className="tour-preview-workspace">
        <aside className={`tour-preview-evidence ${focus === 'evidence' ? 'tour-glow active' : ''}`}>
          <div className="tour-preview-label"><span>2</span><strong>EVIDENCE</strong><small>Click {signals} signals.</small></div>
          <article><span>CHANGE HISTORY</span><strong>09:35 · v3.8.2</strong><small>Retry policy modified</small></article>
          <article><span>ERROR RECORD</span><strong>Inventory timeout</strong><small>Attempt 3 of 3</small></article>
          <article><span>REQUEST PATH</span><strong>Checkout to Inventory</strong><small>2.6 seconds</small></article>
        </aside>

        <div className={`tour-preview-topology ${focus === 'topology' ? 'tour-glow active' : ''}`}>
          <div className="tour-preview-label"><span>3</span><strong>SERVICE TOPOLOGY</strong><small>Where is the failure spreading?</small></div>
          <ServiceTopology contained={false} recovered={false} />
        </div>

        <aside className={`tour-preview-coach ${focus === 'coach' ? 'tour-glow active' : ''}`}>
          <div className="tour-preview-label"><span>4</span><strong>MARA</strong><small>Plain-language coaching</small></div>
          <div className="mini-coach-face"><img src="/coach.webp" alt="" /></div>
          <p>“I will call out what matters and glow the area I mean.”</p>
        </aside>
      </div>

      <div className={`tour-preview-decisions ${focus === 'decisions' ? 'tour-glow active' : ''}`}>
        <div className="tour-preview-label"><span>5</span><strong>DECISION CARDS</strong><small>Choose after Signals reads {signals} / {signals}.</small></div>
        {tourChoices.map((choice, index) => (
          <article key={choice.id}>
            <span>{String.fromCharCode(65 + index)}</span>
            <strong>{choice.label}</strong>
            <small>{index === 0 ? 'Order changes on every new attempt.' : choice.note}</small>
          </article>
        ))}
      </div>
    </section>
  )
}

function BriefingInterfacePreview({ signals }: { signals: number }) {
  const previewChoices = useMemo(() => shuffleChoicesWithMovingAnswer(phaseChoices.diagnose, 1), [])

  return (
    <section className="briefing-interface-preview" aria-label="Preview of the live mission interface">
      <aside className="brief-preview-left">
        <div className="left-title-block">
          <span>INCIDENT 9:42</span>
          <strong>STABILIZE THE STACK</strong>
        </div>
        <div className="brief-preview-card">
          <span>MISSION BRIEF</span>
          <p>The ecommerce checkout is failing. Find the issue, stop the spread, and restore service.</p>
          <ol>
            <li className="active"><i />Investigate the signals</li>
            <li><i />Identify the root cause</li>
            <li><i />Stabilize the stack</li>
            <li><i />Confirm recovery</li>
          </ol>
        </div>
      </aside>

      <div className="brief-preview-center">
        <div className="brief-preview-hud">
          <div className="phase-track" aria-label="Preview phase track">
            {(['diagnose', 'contain', 'recover', 'communicate'] as const).map((item, index) => (
              <span key={item} className={index === 0 ? 'active' : ''}><i>{index + 1}</i>{phaseLabels[item]}</span>
            ))}
          </div>
          <div className="game-stats">
            <div><span>SCORE</span><strong>0</strong></div>
            <div><span>PROGRESS</span><strong>13%</strong></div>
            <div><span>SIGNALS</span><strong>1 / {signals}</strong></div>
          </div>
        </div>
        <ServiceTopology contained={false} recovered={false} />
      </div>

      <aside className="brief-preview-right">
        <section className="right-signal-stack panel">
          <div className="panel-heading"><span>LIVE SIGNALS</span><span>SIGNALS 1 / {signals}</span></div>
          {initialMetrics.map((metric) => (
            <article className={`metric ${metric.tone}`} key={metric.label}>
              <span>{metric.label}</span><strong>{metric.value}</strong><small>{metric.detail}</small>
            </article>
          ))}
        </section>
        <section className="evidence-panel panel attention-panel">
          <div className="panel-heading"><span>EVIDENCE</span><span className="focus-cue"><i /> NEXT · CLICK</span></div>
          <article className="evidence-card selected"><span>CHANGE HISTORY</span><strong>09:35 · v3.8.2</strong><small>Retry policy modified</small></article>
          <article className="evidence-card"><span>CHECKOUT SERVICE LOGS</span><code>9:42:11 ERROR inventory timeout</code></article>
          <article className="evidence-card"><span>APM TRACE</span><small>High latency in checkout flow</small></article>
        </section>
      </aside>

      <div className="brief-preview-decisions">
        <div className="next-decision-card">
          <span>NEXT DECISION</span>
          <strong>What is your next move?</strong>
        </div>
        {previewChoices.map((choice) => (
          <article className="choice-card" key={choice.id}>
            <span className="choice-index">{String.fromCharCode(65 + previewChoices.indexOf(choice))}</span>
            <span><strong>{choice.label}</strong><small>{choice.note}</small></span>
            <i>SELECT</i>
          </article>
        ))}
      </div>
    </section>
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
  const [activeFocus, setActiveFocus] = useState<ActiveFocus | null>(null)
  const [activeAudioKey, setActiveAudioKey] = useState<string | null>(null)
  const [tourFocus, setTourFocus] = useState<TourFocus>('story')
  const [tourNarrating, setTourNarrating] = useState(false)
  const [textSize, setTextSize] = useState<TextSize>(() => (localStorage.getItem('incident-0942-text-size') as TextSize) || 'standard')
  const [difficulty, setDifficulty] = useState<Difficulty>(() => (localStorage.getItem('incident-0942-difficulty') as Difficulty) || 'guided')
  const [phase, setPhase] = useState<Phase>('diagnose')
  const [score, setScore] = useState(0)
  const [streak, setStreak] = useState(0)
  const [reward, setReward] = useState<string | null>(null)
  const [wrongActions, setWrongActions] = useState(0)
  const [hintCount, setHintCount] = useState(0)
  const [selectedEvidence, setSelectedEvidence] = useState<string[]>([])
  const [choiceSets, setChoiceSets] = useState<Record<Exclude<Phase, 'complete'>, Choice[]>>(() => createChoiceSets())
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

  useEffect(() => {
    if (!tourOpen) {
      setTourNarrating(false)
      setTourFocus('story')
      setActiveFocus(null)
      return
    }
    if (!tourNarrating) return
    setTourFocus(tourSteps[0].focus)
    setActiveCaption(tourSteps[0].caption)
    setActiveFocus(mapTourFocusToActiveFocus(tourSteps[0].focus))
    let index = 0
    const timer = window.setInterval(() => {
      index = Math.min(index + 1, tourSteps.length - 1)
      setTourFocus(tourSteps[index].focus)
      setActiveCaption(tourSteps[index].caption)
      setActiveFocus(mapTourFocusToActiveFocus(tourSteps[index].focus))
    }, 4400)
    return () => window.clearInterval(timer)
  }, [tourNarrating, tourOpen])

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
      title: `First step: click ${difficultyConfig.signals} signals`,
      detail: `Use the right rail. Click any ${difficultyConfig.signals} Live Signals or Evidence cards. When Signals shows ${difficultyConfig.signals} / ${difficultyConfig.signals}, move to the bottom answer cards and choose where the failure began.`,
    })
    const introLine = difficulty === 'challenge'
      ? 'Challenge mode selected. The right rail shows checkout errors, latency, payment health, active users, and evidence. Inspect three signals before you make the first call. No training wheels, but the logs are still legally required to tell the truth.'
      : 'You are on call. The right rail shows checkout errors, latency, payment health, active users, and evidence. Inspect two signals before you make the first call.'
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
    setSpeaking(true)
    let audio: HTMLAudioElement | null = null
    const finish = () => {
      if (!audio || currentAudio.current === audio) {
        setSpeaking(false)
        setActiveCaption(null)
        setActiveFocus(null)
        setActiveAudioKey(null)
      }
    }
    const playFallback = () => {
      const utterance = new SpeechSynthesisUtterance(line)
      utterance.voice = selectNarrationVoice('mara')
      utterance.rate = 1.02
      utterance.pitch = 0.96
      utterance.onend = finish
      utterance.onerror = finish
      window.speechSynthesis.speak(utterance)
    }
    const audioUrl = getNarrationSource(audioKey, 'mara')
    if (!audioUrl) {
      currentAudio.current = null
      playFallback()
      return
    }
    audio = new Audio(audioUrl)
    currentAudio.current = audio
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
    if (!choice.correct) {
      speak(choice.coach, choice.audio)
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
    const nextPhase: Phase = phase === 'diagnose' ? 'contain' : phase === 'contain' ? 'recover' : phase === 'recover' ? 'communicate' : 'complete'
    const nextGuidance = difficulty === 'challenge'
      ? phaseGuidance[nextPhase].instruction
      : `${guidedPhaseIntros[nextPhase]} Now do this: ${phaseGuidance[nextPhase].doNow}`
    speak(`${choice.coach} ${nextGuidance}`, `guided-next-${nextPhase}`)
    setScore(nextScore)
    setStreak((count) => count + 1)
    showReward(`PHASE CLEARED · +${points} XP`)
    if (musicEnabled) playUiTone('success')
    setFeedback({
      tone: 'success',
      title: phase === 'communicate' ? 'Mission complete' : `Phase cleared: next step unlocked`,
      detail: nextPhase === 'complete'
        ? `${phaseGuidance.complete.success} Choose Retry for a new randomized attempt.`
        : `Next objective: ${phaseGuidance[nextPhase].objective}. Now do this: ${phaseGuidance[nextPhase].doNow}`,
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

  const reset = () => {
    currentAudio.current?.pause()
    if ('speechSynthesis' in window) window.speechSynthesis.cancel()
    if (speakingTimer.current) window.clearTimeout(speakingTimer.current)
    setAttemptId(null)
    setBriefingOpen(true)
    setTourOpen(false)
    setMissionStarted(false)
    setActiveCaption(null)
    setActiveFocus(null)
    setActiveAudioKey(null)
    setTourFocus('story')
    setTourNarrating(false)
    setPhase('diagnose')
    setScore(0)
    setStreak(0)
    setReward(null)
    setWrongActions(0)
    setHintCount(0)
    setSelectedEvidence([])
    setChoiceSets(createChoiceSets())
    setCoachLine('All right, checkout is on fire. Figuratively, which is the only good news. Start with the evidence.')
    setCoachAudio('intro')
    setSpeaking(false)
    setContained(false)
    setRecovered(false)
    setElapsed(0)
    setTrackingStatus('starting')
    startedAt.current = Date.now()
    setFeedback({
      tone: 'info',
      title: 'Mission briefing required',
      detail: 'Read the incident brief, choose your accessibility settings, then begin the simulation.',
    })
  }

  const currentChoices = phase === 'complete' ? [] : choiceSets[phase]
  const diagnosisReady = phase !== 'diagnose' || selectedEvidence.length >= difficultyConfig.signals
  const integrity = Math.max(0, 100 - wrongActions * difficultyConfig.wrongPenalty - hintCount * difficultyConfig.hintPenalty)
  const rank = phase === 'complete' ? 'STACK STABILIZER' : score >= 60 ? 'INCIDENT LEAD' : score >= 30 ? 'RESPONDER' : 'ON-CALL ENGINEER'
  const progressPercent = phase === 'complete'
    ? 100
    : Math.min(100, Math.round(((phaseNumber[phase] - 1) / 4) * 100 + (phase === 'diagnose' ? Math.min(selectedEvidence.length / difficultyConfig.signals, 1) * 25 : 25)))
  const achievements = [
    selectedEvidence.length >= 4 ? 'SIGNAL HUNTER' : null,
    wrongActions === 0 ? 'CLEAN RUN' : null,
    hintCount === 0 ? 'SELF-SUFFICIENT' : null,
    elapsed <= 300 ? 'FAST CONTAINMENT' : null,
  ].filter(Boolean) as string[]
  const recoveryMetrics = recovered
    ? initialMetrics.map((metric) => metric.label === 'CHECKOUT ERROR RATE'
      ? { ...metric, value: '0.9%', tone: 'healthy' as const, detail: 'Back in range' }
      : metric.label === 'CHECKOUT LATENCY P95'
        ? { ...metric, value: '280 MS', tone: 'healthy' as const, detail: 'Recovered' }
        : metric.label === 'PAYMENT SUCCESS RATE'
          ? { ...metric, value: '99.3%', tone: 'healthy' as const, detail: 'Healthy' }
          : metric)
    : initialMetrics

  const currentDoNow = phase === 'diagnose' && selectedEvidence.length < difficultyConfig.signals
    ? `Click ${difficultyConfig.signals - selectedEvidence.length} more box${difficultyConfig.signals - selectedEvidence.length === 1 ? '' : 'es'}. Then choose one answer.`
    : phase === 'diagnose'
      ? `Signals reads ${difficultyConfig.signals} / ${difficultyConfig.signals}. Choose one answer below.`
      : phaseGuidance[phase].doNow

  const currentInstruction = phase === 'diagnose'
    ? `Click ${difficultyConfig.signals} Live Signals or Evidence cards in the right rail. Then choose what caused the problem.`
    : phaseGuidance[phase].instruction

  const stepNarration = phase === 'diagnose'
    ? `First task. Use the right rail. Click any ${difficultyConfig.signals} Live Signals or Evidence cards. Compare the checkout error rate, checkout latency, payment health, active users, release time, and Inventory timeout. When Signals shows ${difficultyConfig.signals} of ${difficultyConfig.signals}, choose the original cause.`
    : guideScripts[phase]
  const briefingNarration = difficulty === 'challenge'
    ? 'Welcome to Incident nine forty two. Customer support reports that shoppers can fill their carts but cannot complete checkout. Complaints are rising, and failed work is multiplying. You are the on-call responder in Challenge mode. Use the left rail for the mission brief, the center map for service relationships, the right rail for live signals and evidence, and the bottom cards for decisions. Inspect three signals before making the first decision.'
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

            <BriefingInterfacePreview signals={difficultyConfig.signals} />

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
                <div><strong>CLICK {difficultyConfig.signals} SIGNALS</strong><p>Choose any {difficultyConfig.signals} Live Signals or Evidence cards in the right rail.</p></div>
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
                <div><dt>SIGNAL</dt><dd>One live signal or evidence card you inspected.</dd></div>
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
              <p>This is the same interface you will use in the mission. When Mara talks through a region, that exact part of the dashboard glows.</p>
              <NarrationButton
                text={guideScripts.tour}
                audioKey="tour-guide"
                label="LISTEN TO THE INTERFACE TOUR"
                onCaptionChange={(caption) => setGuideCaption(caption, 'briefing')}
                onPlayingChange={setTourNarrating}
              />
            </div>
            <TourInterfacePreview focus={tourFocus} signals={difficultyConfig.signals} />
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
          <div><span>SCORE</span><strong>{score}</strong></div>
          <div><span>PROGRESS</span><strong>{progressPercent}%</strong></div>
          <div><span>SIGNALS</span><strong>{Math.min(selectedEvidence.length, difficultyConfig.signals)} / {difficultyConfig.signals}</strong></div>
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

      <div className="workspace actual-interface">
        <aside className="left-rail">
          <section className={`mission-brief-card panel ${activeFocus === 'briefing' ? 'speaking-focus' : ''}`} aria-label="Mission brief">
            <div className="left-title-block">
              <span>INCIDENT 9:42</span>
              <strong>STABILIZE THE STACK</strong>
            </div>
            <div className="panel-heading"><span>MISSION BRIEF</span><span>9:42</span></div>
            <div className="mission-brief-copy">
              <p>The ecommerce checkout is failing for customers. Your mission is to identify the issue and take the best action to restore service.</p>
              <ol>
                <li className={phaseNumber[phase] >= 1 ? 'active' : ''}><span />Investigate the signals</li>
                <li className={phaseNumber[phase] >= 2 ? 'active' : ''}><span />Identify the root cause</li>
                <li className={phaseNumber[phase] >= 3 ? 'active' : ''}><span />Stabilize the stack</li>
                <li className={phase === 'complete' ? 'active' : ''}><span />Confirm recovery</li>
              </ol>
            </div>
          </section>
          <CoachPanel line={coachLine} speaking={speaking} onReplay={() => speak(coachLine, coachAudio)} captionsEnabled={captionsEnabled} />
          <section className="next-decision-card panel" aria-label="Next decision guidance">
            <span>NEXT DECISION</span>
            <strong>{phase === 'complete' ? 'Mission complete.' : "What's your next move?"}</strong>
            <p>{currentDoNow}</p>
          </section>
        </aside>

        <section className={`system-panel panel ${activeFocus === 'topology' ? 'speaking-focus' : ''}`}>
          <div className="panel-heading"><span>SERVICE TOPOLOGY</span><span className={recovered ? 'status-good' : 'status-live'}>{recovered ? 'RECOVERED' : contained ? 'CONTAINED' : 'DEGRADED'}</span></div>
          <ServiceTopology contained={contained} recovered={recovered} />
        </section>

        <aside className="right-rail">
          <section className={`metric-strip right-signal-stack panel ${activeFocus === 'metrics' ? 'speaking-focus' : ''}`} aria-label="Live incident metrics">
            <div className="panel-heading"><span>LIVE SIGNALS</span><span>SIGNALS {Math.min(selectedEvidence.length, difficultyConfig.signals)} / {difficultyConfig.signals}</span></div>
            {recoveryMetrics.map((metric) => (
              <button className={`metric ${metric.tone} ${speaking && activeAudioKey === metric.audio ? 'spoken-item' : ''}`} key={metric.label} onClick={() => inspectEvidence(metric.label.toLowerCase().replaceAll(' ', '-'), metricCoachLines[metric.label] ?? `${metric.label}: ${metric.detail}.`, metric.audio)}>
                <span>{metric.label}</span><strong>{metric.value}</strong><small>{metric.detail}</small>
              </button>
            ))}
          </section>

          <aside className={`evidence-panel panel ${activeFocus === 'evidence' ? 'speaking-focus' : activeFocus === null && nextFocus === 'evidence' ? 'attention-panel' : ''}`} aria-current={activeFocus === null && nextFocus === 'evidence' ? 'step' : undefined}>
            <div className="panel-heading"><span>EVIDENCE</span>{activeFocus === null && nextFocus === 'evidence' ? <span className="focus-cue"><i /> NEXT · CLICK</span> : <span>{selectedEvidence.length} INSPECTED</span>}</div>
            <button className={`evidence-card ${selectedEvidence.includes('deployment') ? 'selected' : ''} ${speaking && activeAudioKey === 'evidence-deployment' ? 'spoken-item' : ''}`} onClick={() => inspectEvidence('deployment', 'Version 3.8.2 landed seven minutes before the incident. Not proof, but the timing is doing a lot of suspicious work.', 'evidence-deployment')}>
              <span>CHANGE HISTORY</span><strong>09:35 · v3.8.2</strong><small>Retry policy modified</small>
            </button>
            <button className={`evidence-card ${selectedEvidence.includes('logs') ? 'selected' : ''} ${speaking && activeAudioKey === 'evidence-logs' ? 'spoken-item' : ''}`} onClick={() => inspectEvidence('logs', 'Three immediate attempts for one request. That is not resilience. That is the same problem with a loyalty program.', 'evidence-logs')}>
              <span>CHECKOUT SERVICE LOGS</span>
              <code>9:42:11 ERROR inventory timeout</code>
              <code>9:42:11 WARN attempt 3/3</code>
              <code>9:42:12 WARN queue depth 1460</code>
            </button>
            <button className={`evidence-card ${selectedEvidence.includes('trace') ? 'selected' : ''} ${speaking && activeAudioKey === 'evidence-trace' ? 'spoken-item' : ''}`} onClick={() => inspectEvidence('trace', 'Checkout waits 2.6 seconds on Inventory. The database is clean. Please update the suspect list.', 'evidence-trace')}>
              <span>APM TRACE</span>
              <div className="trace"><i style={{ width: '18%' }} /><i className="bad" style={{ width: '64%' }} /><i style={{ width: '12%' }} /></div>
              <small>Checkout → Inventory: 2.6s</small>
            </button>
          </aside>
        </aside>
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
              <NarrationButton text={stepNarration} audioKey={phase === 'diagnose' && difficulty === 'challenge' ? 'diagnose-guide-challenge' : `${phase}-guide`} label="LISTEN TO THIS STEP" onCaptionChange={(caption) => setGuideCaption(caption, phase === 'diagnose' ? 'evidence' : phase === 'contain' || phase === 'recover' ? 'topology' : 'decisions')} />
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
