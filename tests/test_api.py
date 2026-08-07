from app import create_app, db


def make_statement(actor_id: str, attempt_id: str, event: str = "simulation_launched"):
    return {
        "id": f"statement-{event}",
        "actor": {
            "objectType": "Agent",
            "account": {"homePage": "https://hadrienlee.com", "name": actor_id},
        },
        "verb": {"id": "http://adlnet.gov/expapi/verbs/launched"},
        "object": {"id": "https://hadrienlee.com/activities/incident-0942"},
        "context": {
            "extensions": {
                "https://hadrienlee.com/xapi/extensions/attempt": attempt_id,
                "https://hadrienlee.com/xapi/extensions/event": event,
            }
        },
        "timestamp": "2026-08-07T10:00:00Z",
    }


def test_session_statement_and_summary():
    app = create_app({"TESTING": True, "SQLALCHEMY_DATABASE_URI": "sqlite:///:memory:"})
    with app.app_context():
        db.drop_all()
        db.create_all()

    client = app.test_client()
    session = client.post("/api/session", json={"actor_id": "test-learner"})
    assert session.status_code == 201
    attempt_id = session.get_json()["attempt_id"]

    stored = client.post(
        "/api/xapi/statements",
        json=make_statement("test-learner", attempt_id),
    )
    assert stored.status_code == 201

    summary = client.get("/api/dashboard/summary?actor_id=test-learner")
    assert summary.status_code == 200
    assert summary.get_json()["total_attempts"] == 1


def test_rejects_unknown_attempt():
    app = create_app({"TESTING": True, "SQLALCHEMY_DATABASE_URI": "sqlite:///:memory:"})
    client = app.test_client()
    response = client.post(
        "/api/xapi/statements",
        json=make_statement("test-learner", "missing"),
    )
    assert response.status_code == 404


def test_completed_statement_updates_attempt():
    app = create_app({"TESTING": True, "SQLALCHEMY_DATABASE_URI": "sqlite:///:memory:"})
    with app.app_context():
        db.drop_all()
        db.create_all()

    client = app.test_client()
    attempt_id = client.post("/api/session", json={"actor_id": "test-learner"}).get_json()["attempt_id"]
    statement = make_statement("test-learner", attempt_id, "simulation_completed")
    statement["id"] = "completed-statement"
    statement["verb"]["id"] = "http://adlnet.gov/expapi/verbs/completed"
    statement["result"] = {"success": True, "score": {"raw": 88, "min": 0, "max": 100}}

    response = client.post("/api/xapi/statements", json=statement)
    assert response.status_code == 201

    attempt = client.get("/api/attempts/test-learner").get_json()["attempts"][0]
    assert attempt["status"] == "completed"
    assert attempt["score"] == 88
    assert attempt["outcome"] == "stabilized"
