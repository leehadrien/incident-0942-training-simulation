from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS
from flask_sqlalchemy import SQLAlchemy
from sqlalchemy import JSON, DateTime, Float, Integer, String, Text, func
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


db = SQLAlchemy(model_class=Base)
ROOT = Path(__file__).resolve().parent
FRONTEND_ROOT = ROOT / "frontend" if (ROOT / "frontend" / "package.json").exists() else ROOT
FRONTEND_DIST = FRONTEND_ROOT / "dist"


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Attempt(db.Model):
    __tablename__ = "attempts"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    actor_id: Mapped[str] = mapped_column(String(80), index=True)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    status: Mapped[str] = mapped_column(String(24), default="in_progress")
    phase: Mapped[str] = mapped_column(String(24), default="diagnose")
    score: Mapped[int] = mapped_column(Integer, default=0)
    outcome: Mapped[str | None] = mapped_column(String(24), nullable=True)
    hints: Mapped[int] = mapped_column(Integer, default=0)
    wrong_actions: Mapped[int] = mapped_column(Integer, default=0)
    time_to_contain_seconds: Mapped[float | None] = mapped_column(Float, nullable=True)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "actor_id": self.actor_id,
            "started_at": self.started_at.isoformat(),
            "completed_at": self.completed_at.isoformat() if self.completed_at else None,
            "status": self.status,
            "phase": self.phase,
            "score": self.score,
            "outcome": self.outcome,
            "hints": self.hints,
            "wrong_actions": self.wrong_actions,
            "time_to_contain_seconds": self.time_to_contain_seconds,
        }


class XAPIStatement(db.Model):
    __tablename__ = "xapi_statements"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    attempt_id: Mapped[str] = mapped_column(String(36), index=True)
    actor_id: Mapped[str] = mapped_column(String(80), index=True)
    verb_id: Mapped[str] = mapped_column(Text)
    object_id: Mapped[str] = mapped_column(Text)
    event_name: Mapped[str] = mapped_column(String(80), index=True)
    timestamp: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    payload: Mapped[dict[str, Any]] = mapped_column(JSON)


def create_app(test_config: dict[str, Any] | None = None) -> Flask:
    app = Flask(__name__, static_folder=None)
    database_url = os.getenv("DATABASE_URL", f"sqlite:///{ROOT / 'training.db'}")
    if database_url.startswith("postgres://"):
        database_url = database_url.replace("postgres://", "postgresql+psycopg://", 1)
    elif database_url.startswith("postgresql://"):
        database_url = database_url.replace("postgresql://", "postgresql+psycopg://", 1)

    app.config.update(
        SQLALCHEMY_DATABASE_URI=database_url,
        SQLALCHEMY_TRACK_MODIFICATIONS=False,
        SECRET_KEY=os.getenv("SECRET_KEY", "local-development-only"),
        MAX_CONTENT_LENGTH=256 * 1024,
    )
    if test_config:
        app.config.update(test_config)

    db.init_app(app)
    allowed_origins = [
        origin.strip()
        for origin in os.getenv(
            "ALLOWED_ORIGINS",
            "http://localhost:5173,http://127.0.0.1:5173,https://hadrienlee.com",
        ).split(",")
        if origin.strip()
    ]
    CORS(app, resources={r"/api/*": {"origins": allowed_origins}})

    with app.app_context():
        db.create_all()

    register_routes(app)
    return app


def _json_body() -> dict[str, Any]:
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        raise ValueError("A JSON object is required.")
    return body


def _attempt_extension(statement: dict[str, Any]) -> str | None:
    return (
        statement.get("context", {})
        .get("extensions", {})
        .get("https://hadrienlee.com/xapi/extensions/attempt")
    )


def register_routes(app: Flask) -> None:
    @app.after_request
    def security_headers(response):
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
        response.headers.setdefault(
            "Content-Security-Policy",
            "frame-ancestors 'self' https://*.webflow.io https://*.webflow.com https://hadrienlee.com https://*.hadrienlee.com",
        )
        return response

    @app.get("/api/health")
    def health():
        return jsonify({"status": "ok", "service": "incident-0942"})

    @app.post("/api/session")
    def create_session():
        try:
            body = _json_body()
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400

        actor_id = str(body.get("actor_id", "")).strip()[:80]
        if not actor_id:
            actor_id = f"learner-{uuid.uuid4()}"

        attempt = Attempt(id=str(uuid.uuid4()), actor_id=actor_id)
        db.session.add(attempt)
        db.session.commit()
        return jsonify({"actor_id": actor_id, "attempt_id": attempt.id}), 201

    @app.post("/api/xapi/statements")
    def ingest_statement():
        try:
            statement = _json_body()
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400

        required = ("actor", "verb", "object", "timestamp")
        if any(key not in statement for key in required):
            return jsonify({"error": "Statement requires actor, verb, object, and timestamp."}), 400

        attempt_id = _attempt_extension(statement)
        actor_id = statement.get("actor", {}).get("account", {}).get("name")
        verb_id = statement.get("verb", {}).get("id")
        object_id = statement.get("object", {}).get("id")
        event_name = (
            statement.get("context", {})
            .get("extensions", {})
            .get("https://hadrienlee.com/xapi/extensions/event", "activity")
        )

        if not all(isinstance(value, str) and value for value in (attempt_id, actor_id, verb_id, object_id)):
            return jsonify({"error": "Statement identifiers are incomplete."}), 400

        attempt = db.session.get(Attempt, attempt_id)
        if attempt is None or attempt.actor_id != actor_id:
            return jsonify({"error": "Unknown attempt."}), 404

        statement_id = str(statement.get("id") or uuid.uuid4())
        if db.session.get(XAPIStatement, statement_id):
            return jsonify({"id": statement_id, "stored": False, "duplicate": True}), 200

        row = XAPIStatement(
            id=statement_id,
            attempt_id=attempt_id,
            actor_id=actor_id,
            verb_id=verb_id,
            object_id=object_id,
            event_name=str(event_name)[:80],
            payload=statement,
        )
        db.session.add(row)

        extensions = statement.get("context", {}).get("extensions", {})
        attempt.phase = str(extensions.get("https://hadrienlee.com/xapi/extensions/phase", attempt.phase))[:24]
        if event_name == "hint_requested":
            attempt.hints += 1
        elif event_name == "unsupported_action":
            attempt.wrong_actions += 1
        elif event_name == "dependency_contained":
            elapsed = extensions.get("https://hadrienlee.com/xapi/extensions/elapsed_seconds")
            if isinstance(elapsed, (int, float)):
                attempt.time_to_contain_seconds = float(elapsed)
        elif event_name == "simulation_completed":
            result = statement.get("result", {})
            raw_score = result.get("score", {}).get("raw", 0)
            attempt.score = max(0, min(100, int(raw_score)))
            attempt.outcome = "stabilized" if result.get("success") else "needs_review"
            attempt.status = "completed"
            attempt.phase = "complete"
            attempt.completed_at = utcnow()

        db.session.commit()
        return jsonify({"id": statement_id, "stored": True}), 201

    @app.get("/api/attempts/<actor_id>")
    def actor_attempts(actor_id: str):
        rows = db.session.execute(
            db.select(Attempt)
            .where(Attempt.actor_id == actor_id)
            .order_by(Attempt.started_at.desc())
            .limit(50)
        ).scalars()
        return jsonify({"attempts": [row.to_dict() for row in rows]})

    @app.get("/api/dashboard/summary")
    def dashboard_summary():
        actor_id = request.args.get("actor_id")
        query = db.select(Attempt)
        if actor_id:
            query = query.where(Attempt.actor_id == actor_id)
        attempts = list(db.session.execute(query.order_by(Attempt.started_at.desc())).scalars())
        completed = [row for row in attempts if row.status == "completed"]

        avg_score = round(sum(row.score for row in completed) / len(completed), 1) if completed else 0
        contain_times = [row.time_to_contain_seconds for row in completed if row.time_to_contain_seconds is not None]
        avg_contain = round(sum(contain_times) / len(contain_times), 1) if contain_times else 0

        return jsonify(
            {
                "total_attempts": len(attempts),
                "completed_attempts": len(completed),
                "average_score": avg_score,
                "best_score": max((row.score for row in completed), default=0),
                "average_time_to_contain_seconds": avg_contain,
                "total_hints": sum(row.hints for row in attempts),
                "total_unsupported_actions": sum(row.wrong_actions for row in attempts),
                "attempts": [row.to_dict() for row in attempts[:12]],
            }
        )

    @app.get("/")
    @app.get("/training/incident-0942")
    @app.get("/dashboard")
    def frontend_index():
        index_path = FRONTEND_DIST / "index.html"
        if index_path.exists():
            return send_from_directory(FRONTEND_DIST, "index.html")
        return jsonify({"message": "Frontend has not been built. Run npm run build in frontend."}), 503

    @app.get("/<path:path>")
    def frontend_assets(path: str):
        candidate = FRONTEND_DIST / path
        if candidate.exists() and candidate.is_file():
            return send_from_directory(FRONTEND_DIST, path)
        if (FRONTEND_DIST / "index.html").exists():
            return send_from_directory(FRONTEND_DIST, "index.html")
        return jsonify({"error": "Not found"}), 404


app = create_app()


if __name__ == "__main__":
    app.run(debug=True, port=5000)
