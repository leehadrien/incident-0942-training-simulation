# Incident 09:42: Stabilize the Stack

An interactive technical-training simulation built for Hadrien Lee's AI and learning experience design portfolio.

## What it demonstrates

- Evidence-based incident diagnosis
- Branching technical decisions with visible consequences
- xAPI-compatible learning event tracking
- Persistent repeated-attempt analytics
- An accessible, responsive training interface
- Twenty-five locally hosted Remy voice clips generated with Higgsfield's ElevenLabs engine
- A connected learning ecosystem across the training, dashboard, and AI tutor projects

## Voice layer

Mara's short coaching reactions are stored in `frontend/public/audio` and selected with stable interaction keys. Audio starts only after a learner action or a replay click, which respects browser autoplay rules. A new interaction interrupts the previous clip so rapid exploration never stacks narration.

## Local development

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

cd frontend
npm install
npm run dev
```

In another terminal:

```bash
source .venv/bin/activate
python app.py
```

The Vite development server proxies `/api` to Flask on port 5000.

## Verification

```bash
cd frontend
npm run build

cd ..
.venv/bin/pytest -q
```

## Production

Render runs `build.sh`, serves the compiled React application through Flask, and stores attempt data in PostgreSQL. The included `render.yaml` defines both services.

## Routes

- `/training/incident-0942` live simulation
- `/dashboard` attempt analytics
- `/api/session` start an attempt
- `/api/xapi/statements` ingest xAPI-compatible events
- `/api/dashboard/summary` aggregate results
- `/api/health` deployment health check
