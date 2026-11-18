from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from typing import Any

from .config import settings


PAGE_SIZE = 20


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
                external_id TEXT,
                cancel_requested INTEGER NOT NULL DEFAULT 0,
                FOREIGN KEY(result_media_id) REFERENCES media(id) ON DELETE SET NULL
            );

            CREATE INDEX IF NOT EXISTS idx_jobs_status_created
                ON jobs(status, created_at);

            CREATE INDEX IF NOT EXISTS idx_media_created
                ON media(created_at DESC);
            """
        )
        _ensure_jobs_columns(conn)


def _ensure_jobs_columns(conn: sqlite3.Connection) -> None:
    columns = {row["name"] for row in conn.execute("PRAGMA table_info(jobs)").fetchall()}
    if "external_id" not in columns:
        conn.execute("ALTER TABLE jobs ADD COLUMN external_id TEXT")
    if "cancel_requested" not in columns:
        conn.execute(
            "ALTER TABLE jobs ADD COLUMN cancel_requested INTEGER NOT NULL DEFAULT 0"
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
                   external_id=NULL,
                   cancel_requested=0,
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
                id, kind, status, progress, stage, payload_json,
                created_at, external_id, cancel_requested
            ) VALUES (?, ?, 'queued', 0, 'В очереди', ?, ?, NULL, 0)
            """,
            (job_id, kind, json.dumps(payload, ensure_ascii=False), utcnow()),
        )


def get_job(job_id: str) -> dict[str, Any] | None:
    with connect() as conn:
        row = conn.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
    return _decode_job(row) if row else None


def clone_failed_job(source_job_id: str, new_job_id: str) -> dict[str, Any]:
    source = get_job(source_job_id)
    if source is None:
        raise LookupError("Job not found")
    if source["status"] != "failed":
        raise ValueError("Only failed jobs can be retried")
    enqueue_job(new_job_id, source["kind"], source["payload"])
    return source


def claim_next_job() -> dict[str, Any] | None:
    with connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            """
            SELECT *
              FROM jobs
             WHERE status='queued' AND cancel_requested=0
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
                   external_id=NULL,
                   cancel_requested=0,
                   error=NULL
             WHERE id=?
            """,
            (started_at, row["id"]),
        )
        conn.execute("COMMIT")

    result = _decode_job(row)
    result["status"] = "running"
    result["started_at"] = started_at
    result["cancel_requested"] = 0
    return result


def update_job(
    job_id: str,
    *,
    progress: float | None = None,
    stage: str | None = None,
    external_id: str | None = None,
) -> None:
    fields: list[str] = []
    values: list[Any] = []

    if progress is not None:
        fields.append("progress=?")
        values.append(max(0.0, min(100.0, float(progress))))
    if stage is not None:
        fields.append("stage=?")
        values.append(stage)
    if external_id is not None:
        fields.append("external_id=?")
        values.append(external_id)

    if not fields:
        return

    values.append(job_id)
    with connect() as conn:
        conn.execute(
            f"UPDATE jobs SET {', '.join(fields)} WHERE id=?",
            values,
        )


def request_cancel(job_id: str) -> dict[str, Any] | None:
    with connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
        if row is None:
            conn.execute("COMMIT")
            return None

        status = row["status"]
        if status == "queued":
            conn.execute(
                """
                UPDATE jobs
                   SET status='canceled',
                       stage='Отменено',
                       cancel_requested=1,
                       finished_at=?
                 WHERE id=?
                """,
                (utcnow(), job_id),
            )
        elif status == "running":
            conn.execute(
                """
                UPDATE jobs
                   SET cancel_requested=1,
                       stage='Отмена...'
                 WHERE id=?
                """,
                (job_id,),
            )
        conn.execute("COMMIT")

    return get_job(job_id)


def is_cancel_requested(job_id: str) -> bool:
    with connect() as conn:
        row = conn.execute(
            "SELECT cancel_requested, status FROM jobs WHERE id=?",
            (job_id,),
        ).fetchone()
    return bool(row and (row["cancel_requested"] or row["status"] == "canceled"))


def mark_cancelled(job_id: str) -> None:
    with connect() as conn:
        conn.execute(
            """
            UPDATE jobs
               SET status='canceled',
                   stage='Отменено',
                   cancel_requested=1,
                   finished_at=?,
                   error=NULL
             WHERE id=?
            """,
            (utcnow(), job_id),
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
                   finished_at=?,
                   cancel_requested=0
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


def list_media_page(page: int, page_size: int = PAGE_SIZE) -> dict[str, Any]:
    page = max(1, int(page))
    page_size = max(1, min(100, int(page_size)))
    with connect() as conn:
        total = int(conn.execute("SELECT COUNT(*) FROM media").fetchone()[0])
        pages = max(1, (total + page_size - 1) // page_size)
        page = min(page, pages)
        rows = conn.execute(
            """
            SELECT *
              FROM media
             ORDER BY created_at DESC
             LIMIT ? OFFSET ?
            """,
            (page_size, (page - 1) * page_size),
        ).fetchall()
    return _page_result([_decode_media(row) for row in rows], page, page_size, total)


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
    return [_decode_job(row) for row in rows]


def list_jobs_page(page: int, page_size: int = PAGE_SIZE) -> dict[str, Any]:
    page = max(1, int(page))
    page_size = max(1, min(100, int(page_size)))
    with connect() as conn:
        total = int(conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0])
        pages = max(1, (total + page_size - 1) // page_size)
        page = min(page, pages)
        rows = conn.execute(
            """
            SELECT *
              FROM jobs
             ORDER BY created_at DESC
             LIMIT ? OFFSET ?
            """,
            (page_size, (page - 1) * page_size),
        ).fetchall()
    return _page_result([_decode_job(row) for row in rows], page, page_size, total)


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


def _page_result(items: list[dict[str, Any]], page: int, page_size: int, total: int) -> dict[str, Any]:
    pages = max(1, (total + page_size - 1) // page_size)
    if page > pages:
        page = pages
    return {
        "items": items,
        "page": page,
        "page_size": page_size,
        "total": total,
        "pages": pages,
    }


def _decode_job(row: sqlite3.Row) -> dict[str, Any]:
    item = dict(row)
    try:
        item["payload"] = json.loads(item.pop("payload_json"))
    except Exception:
        item["payload"] = {}
        item.pop("payload_json", None)
    return item


def _decode_media(row: sqlite3.Row) -> dict[str, Any]:
    item = dict(row)
    try:
        item["meta"] = json.loads(item.pop("meta_json"))
    except Exception:
        item["meta"] = {}
        item.pop("meta_json", None)
    return item
