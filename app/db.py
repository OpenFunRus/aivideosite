from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from typing import Any

from .config import settings


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def connect() -> sqlite3.Connection:
    conn = sqlite3.connect(settings.db_path, timeout=30, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous = NORMAL")
    return conn


def init_db() -> None:
    with connect() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS media (
                id TEXT PRIMARY KEY,
                parent_id TEXT,
                kind TEXT NOT NULL,
                filename TEXT NOT NULL UNIQUE,
                title TEXT NOT NULL,
                meta_json TEXT NOT NULL DEFAULT '{}',
                size_bytes INTEGER NOT NULL DEFAULT 0,
                duration REAL,
                created_at TEXT NOT NULL,
                FOREIGN KEY(parent_id) REFERENCES media(id) ON DELETE SET NULL
            );

            CREATE TABLE IF NOT EXISTS jobs (
                id TEXT PRIMARY KEY,
                kind TEXT NOT NULL,
                status TEXT NOT NULL,
                progress REAL NOT NULL DEFAULT 0,
                stage TEXT NOT NULL DEFAULT '',
                payload_json TEXT NOT NULL,
                result_media_id TEXT,
                error TEXT,
                created_at TEXT NOT NULL,
                started_at TEXT,
                finished_at TEXT,
                FOREIGN KEY(result_media_id) REFERENCES media(id) ON DELETE SET NULL
            );

            CREATE INDEX IF NOT EXISTS idx_jobs_status_created
                ON jobs(status, created_at);

            CREATE INDEX IF NOT EXISTS idx_media_created
                ON media(created_at DESC);
            """
        )


def recover_interrupted_jobs() -> int:
    with connect() as conn:
        cur = conn.execute(
            """
            UPDATE jobs
               SET status='queued',
                   stage='Восстановлено после перезапуска',
                   progress=0,
                   started_at=NULL,
                   error=NULL
             WHERE status='running'
            """
        )
        return cur.rowcount


def enqueue_job(job_id: str, kind: str, payload: dict[str, Any]) -> None:
    with connect() as conn:
        conn.execute(
            """
            INSERT INTO jobs(
                id, kind, status, progress, stage, payload_json, created_at
            ) VALUES (?, ?, 'queued', 0, 'В очереди', ?, ?)
            """,
            (job_id, kind, json.dumps(payload, ensure_ascii=False), utcnow()),
        )


def claim_next_job() -> dict[str, Any] | None:
    with connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            """
            SELECT *
              FROM jobs
             WHERE status='queued'
             ORDER BY created_at ASC
             LIMIT 1
            """
        ).fetchone()
        if row is None:
            conn.execute("COMMIT")
            return None

        started_at = utcnow()
        conn.execute(
            """
            UPDATE jobs
               SET status='running',
                   stage='Запуск',
                   progress=1,
                   started_at=?,
                   error=NULL
             WHERE id=?
            """,
            (started_at, row["id"]),
        )
        conn.execute("COMMIT")

    result = dict(row)
    result["status"] = "running"
    result["started_at"] = started_at
    result["payload"] = json.loads(result.pop("payload_json"))
    return result


def update_job(
    job_id: str,
    *,
    progress: float | None = None,
    stage: str | None = None,
) -> None:
    fields: list[str] = []
    values: list[Any] = []

    if progress is not None:
        fields.append("progress=?")
        values.append(max(0.0, min(100.0, float(progress))))
    if stage is not None:
        fields.append("stage=?")
        values.append(stage)

    if not fields:
        return

    values.append(job_id)
    with connect() as conn:
        conn.execute(
            f"UPDATE jobs SET {', '.join(fields)} WHERE id=?",
            values,
        )


def complete_job(job_id: str, media_id: str | None = None) -> None:
    with connect() as conn:
        conn.execute(
            """
            UPDATE jobs
               SET status='done',
                   progress=100,
                   stage='Готово',
                   result_media_id=?,
                   finished_at=?
             WHERE id=?
            """,
            (media_id, utcnow(), job_id),
        )


def fail_job(job_id: str, error: str) -> None:
    error = (error or "Неизвестная ошибка").strip()
    if len(error) > 8000:
        error = error[-8000:]
    with connect() as conn:
        conn.execute(
            """
            UPDATE jobs
               SET status='failed',
                   stage='Ошибка',
                   error=?,
                   finished_at=?
             WHERE id=?
            """,
            (error, utcnow(), job_id),
        )


def insert_media(
    *,
    media_id: str,
    filename: str,
    kind: str,
    title: str,
    parent_id: str | None,
    metadata: dict[str, Any],
    size_bytes: int,
    duration: float | None,
) -> None:
    with connect() as conn:
        conn.execute(
            """
            INSERT INTO media(
                id, parent_id, kind, filename, title,
                meta_json, size_bytes, duration, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                media_id,
                parent_id,
                kind,
                filename,
                title,
                json.dumps(metadata, ensure_ascii=False),
                int(size_bytes),
                duration,
                utcnow(),
            ),
        )


def get_media(media_id: str) -> dict[str, Any] | None:
    with connect() as conn:
        row = conn.execute(
            "SELECT * FROM media WHERE id=?",
            (media_id,),
        ).fetchone()
    return _decode_media(row) if row else None


def list_media(limit: int = 100) -> list[dict[str, Any]]:
    with connect() as conn:
        rows = conn.execute(
            """
            SELECT *
              FROM media
             ORDER BY created_at DESC
             LIMIT ?
            """,
            (max(1, min(500, limit)),),
        ).fetchall()
    return [_decode_media(row) for row in rows]


def delete_media_row(media_id: str) -> None:
    with connect() as conn:
        conn.execute("DELETE FROM media WHERE id=?", (media_id,))


def list_jobs(limit: int = 100) -> list[dict[str, Any]]:
    with connect() as conn:
        rows = conn.execute(
            """
            SELECT *
              FROM jobs
             ORDER BY created_at DESC
             LIMIT ?
            """,
            (max(1, min(500, limit)),),
        ).fetchall()

    result = []
    for row in rows:
        item = dict(row)
        try:
            item["payload"] = json.loads(item.pop("payload_json"))
        except Exception:
            item["payload"] = {}
            item.pop("payload_json", None)
        result.append(item)
    return result


def state_counts() -> dict[str, int]:
    with connect() as conn:
        queued = conn.execute(
            "SELECT COUNT(*) FROM jobs WHERE status='queued'"
        ).fetchone()[0]
        running = conn.execute(
            "SELECT COUNT(*) FROM jobs WHERE status='running'"
        ).fetchone()[0]
        media_count = conn.execute("SELECT COUNT(*) FROM media").fetchone()[0]
    return {
        "queued": int(queued),
        "running": int(running),
        "media": int(media_count),
    }


def _decode_media(row: sqlite3.Row) -> dict[str, Any]:
    item = dict(row)
    try:
        item["meta"] = json.loads(item.pop("meta_json"))
    except Exception:
        item["meta"] = {}
        item.pop("meta_json", None)
    return item
