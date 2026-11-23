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
                owner_id TEXT NOT NULL DEFAULT 'user1',
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

            CREATE TABLE IF NOT EXISTS characters (
                id TEXT PRIMARY KEY,
                owner_id TEXT NOT NULL,
                name TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                images_json TEXT NOT NULL DEFAULT '[]',
                voice_file TEXT,
                voice_preset_id TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_characters_owner_created
                ON characters(owner_id, created_at DESC);

            CREATE TABLE IF NOT EXISTS locations (
                id TEXT PRIMARY KEY,
                owner_id TEXT NOT NULL,
                name TEXT NOT NULL,
                prompt TEXT NOT NULL DEFAULT '',
                images_json TEXT NOT NULL DEFAULT '[]',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_locations_owner_created
                ON locations(owner_id, created_at DESC);

            CREATE TABLE IF NOT EXISTS jobs (
                id TEXT PRIMARY KEY,
                owner_id TEXT NOT NULL DEFAULT 'user1',
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
        _ensure_owner_columns(conn)
        _ensure_character_columns(conn)
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_jobs_owner_created "
            "ON jobs(owner_id, created_at DESC)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_media_owner_created "
            "ON media(owner_id, created_at DESC)"
        )


def _ensure_jobs_columns(conn: sqlite3.Connection) -> None:
    columns = {row["name"] for row in conn.execute("PRAGMA table_info(jobs)").fetchall()}
    if "external_id" not in columns:
        conn.execute("ALTER TABLE jobs ADD COLUMN external_id TEXT")
    if "cancel_requested" not in columns:
        conn.execute(
            "ALTER TABLE jobs ADD COLUMN cancel_requested INTEGER NOT NULL DEFAULT 0"
        )


def _ensure_owner_columns(conn: sqlite3.Connection) -> None:
    job_columns = {
        row["name"] for row in conn.execute("PRAGMA table_info(jobs)").fetchall()
    }
    if "owner_id" not in job_columns:
        conn.execute(
            "ALTER TABLE jobs ADD COLUMN owner_id TEXT NOT NULL DEFAULT 'user1'"
        )

    media_columns = {
        row["name"] for row in conn.execute("PRAGMA table_info(media)").fetchall()
    }
    if "owner_id" not in media_columns:
        conn.execute(
            "ALTER TABLE media ADD COLUMN owner_id TEXT NOT NULL DEFAULT 'user1'"
        )


def _ensure_character_columns(conn: sqlite3.Connection) -> None:
    columns = {
        row["name"] for row in conn.execute("PRAGMA table_info(characters)").fetchall()
    }
    if "voice_preset_id" not in columns:
        conn.execute("ALTER TABLE characters ADD COLUMN voice_preset_id TEXT")


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


def enqueue_job(
    job_id: str,
    kind: str,
    payload: dict[str, Any],
    owner_id: str = "user1",
) -> None:
    with connect() as conn:
        conn.execute(
            """
            INSERT INTO jobs(
                id, owner_id, kind, status, progress, stage, payload_json,
                created_at, external_id, cancel_requested
            ) VALUES (?, ?, ?, 'queued', 0, 'В очереди', ?, ?, NULL, 0)
            """,
            (
                job_id,
                owner_id,
                kind,
                json.dumps(payload, ensure_ascii=False),
                utcnow(),
            ),
        )


def get_job(job_id: str, owner_id: str | None = None) -> dict[str, Any] | None:
    with connect() as conn:
        if owner_id is None:
            row = conn.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
        else:
            row = conn.execute(
                "SELECT * FROM jobs WHERE id=? AND owner_id=?",
                (job_id, owner_id),
            ).fetchone()
    return _decode_job(row) if row else None


def clone_failed_job(source_job_id: str, new_job_id: str) -> dict[str, Any]:
    source = get_job(source_job_id)
    if source is None:
        raise LookupError("Job not found")
    if source["status"] != "failed":
        raise ValueError("Only failed jobs can be retried")
    enqueue_job(
        new_job_id,
        source["kind"],
        source["payload"],
        owner_id=str(source.get("owner_id") or "user1"),
    )
    return source


def claim_next_job(kinds: set[str] | None = None) -> dict[str, Any] | None:
    with connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        params: list[Any] = []
        kind_clause = ""
        if kinds:
            ordered_kinds = sorted(kinds)
            placeholders = ",".join("?" for _ in ordered_kinds)
            kind_clause = f" AND kind IN ({placeholders})"
            params.extend(ordered_kinds)

        row = conn.execute(
            f"""
            SELECT *
              FROM jobs
             WHERE status='queued' AND cancel_requested=0
                   {kind_clause}
             ORDER BY created_at ASC
             LIMIT 1
            """,
            params,
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


def request_cancel(
    job_id: str,
    owner_id: str | None = None,
) -> dict[str, Any] | None:
    with connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        if owner_id is None:
            row = conn.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
        else:
            row = conn.execute(
                "SELECT * FROM jobs WHERE id=? AND owner_id=?",
                (job_id, owner_id),
            ).fetchone()
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

    return get_job(job_id, owner_id)


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
    owner_id: str = "user1",
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
                id, owner_id, parent_id, kind, filename, title,
                meta_json, size_bytes, duration, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                media_id,
                owner_id,
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


def get_media(media_id: str, owner_id: str | None = None) -> dict[str, Any] | None:
    with connect() as conn:
        if owner_id is None:
            row = conn.execute(
                "SELECT * FROM media WHERE id=?",
                (media_id,),
            ).fetchone()
        else:
            row = conn.execute(
                "SELECT * FROM media WHERE id=? AND owner_id=?",
                (media_id, owner_id),
            ).fetchone()
    return _decode_media(row) if row else None


def list_media(
    limit: int = 100,
    owner_id: str | None = None,
) -> list[dict[str, Any]]:
    limit = max(1, min(500, limit))
    with connect() as conn:
        if owner_id is None:
            rows = conn.execute(
                "SELECT * FROM media ORDER BY created_at DESC LIMIT ?",
                (limit,),
            ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT *
                  FROM media
                 WHERE owner_id=?
                 ORDER BY created_at DESC
                 LIMIT ?
                """,
                (owner_id, limit),
            ).fetchall()
    return [_decode_media(row) for row in rows]


def list_media_page(
    page: int,
    page_size: int = PAGE_SIZE,
    owner_id: str | None = None,
) -> dict[str, Any]:
    page = max(1, int(page))
    page_size = max(1, min(100, int(page_size)))
    with connect() as conn:
        if owner_id is None:
            total = int(conn.execute("SELECT COUNT(*) FROM media").fetchone()[0])
        else:
            total = int(
                conn.execute(
                    "SELECT COUNT(*) FROM media WHERE owner_id=?",
                    (owner_id,),
                ).fetchone()[0]
            )
        pages = max(1, (total + page_size - 1) // page_size)
        page = min(page, pages)
        if owner_id is None:
            rows = conn.execute(
                "SELECT * FROM media ORDER BY created_at DESC LIMIT ? OFFSET ?",
                (page_size, (page - 1) * page_size),
            ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT *
                  FROM media
                 WHERE owner_id=?
                 ORDER BY created_at DESC
                 LIMIT ? OFFSET ?
                """,
                (owner_id, page_size, (page - 1) * page_size),
            ).fetchall()
    return _page_result([_decode_media(row) for row in rows], page, page_size, total)


def delete_media_row(media_id: str, owner_id: str | None = None) -> None:
    with connect() as conn:
        if owner_id is None:
            conn.execute("DELETE FROM media WHERE id=?", (media_id,))
        else:
            conn.execute(
                "DELETE FROM media WHERE id=? AND owner_id=?",
                (media_id, owner_id),
            )


def list_jobs(
    limit: int = 100,
    owner_id: str | None = None,
) -> list[dict[str, Any]]:
    limit = max(1, min(500, limit))
    with connect() as conn:
        if owner_id is None:
            rows = conn.execute(
                "SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?",
                (limit,),
            ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT *
                  FROM jobs
                 WHERE owner_id=?
                 ORDER BY created_at DESC
                 LIMIT ?
                """,
                (owner_id, limit),
            ).fetchall()
    return [_decode_job(row) for row in rows]


def list_jobs_page(
    page: int,
    page_size: int = PAGE_SIZE,
    owner_id: str | None = None,
) -> dict[str, Any]:
    page = max(1, int(page))
    page_size = max(1, min(100, int(page_size)))
    with connect() as conn:
        if owner_id is None:
            total = int(conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0])
        else:
            total = int(
                conn.execute(
                    "SELECT COUNT(*) FROM jobs WHERE owner_id=?",
                    (owner_id,),
                ).fetchone()[0]
            )
        pages = max(1, (total + page_size - 1) // page_size)
        page = min(page, pages)
        if owner_id is None:
            rows = conn.execute(
                "SELECT * FROM jobs ORDER BY created_at DESC LIMIT ? OFFSET ?",
                (page_size, (page - 1) * page_size),
            ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT *
                  FROM jobs
                 WHERE owner_id=?
                 ORDER BY created_at DESC
                 LIMIT ? OFFSET ?
                """,
                (owner_id, page_size, (page - 1) * page_size),
            ).fetchall()
    return _page_result([_decode_job(row) for row in rows], page, page_size, total)


def delete_terminal_job(
    job_id: str,
    owner_id: str | None = None,
) -> dict[str, Any] | None:
    with connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        if owner_id is None:
            row = conn.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
        else:
            row = conn.execute(
                "SELECT * FROM jobs WHERE id=? AND owner_id=?",
                (job_id, owner_id),
            ).fetchone()
        if row is None:
            conn.execute("COMMIT")
            return None
        if row["status"] in {"queued", "running"}:
            conn.execute("ROLLBACK")
            raise ValueError("Active jobs cannot be deleted")
        conn.execute("DELETE FROM jobs WHERE id=?", (job_id,))
        conn.execute("COMMIT")
    return _decode_job(row)


def clear_nonrunning_jobs(
    owner_id: str | None = None,
) -> list[dict[str, Any]]:
    with connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        if owner_id is None:
            rows = conn.execute(
                "SELECT * FROM jobs WHERE status != 'running'"
            ).fetchall()
            conn.execute("DELETE FROM jobs WHERE status != 'running'")
        else:
            rows = conn.execute(
                "SELECT * FROM jobs WHERE owner_id=? AND status != 'running'",
                (owner_id,),
            ).fetchall()
            conn.execute(
                "DELETE FROM jobs WHERE owner_id=? AND status != 'running'",
                (owner_id,),
            )
        conn.execute("COMMIT")
    return [_decode_job(row) for row in rows]


def active_character_ids(owner_id: str) -> set[str]:
    protected: set[str] = set()
    with connect() as conn:
        rows = conn.execute(
            """
            SELECT payload_json
              FROM jobs
             WHERE owner_id=? AND status IN ('queued', 'running')
            """,
            (owner_id,),
        ).fetchall()
    for row in rows:
        try:
            payload = json.loads(row["payload_json"])
        except Exception:
            continue
        for item in payload.get("references") or []:
            if isinstance(item, dict) and item.get("character_id"):
                protected.add(str(item["character_id"]))
    return protected


def active_location_ids(owner_id: str) -> set[str]:
    protected: set[str] = set()
    with connect() as conn:
        rows = conn.execute(
            """
            SELECT payload_json
              FROM jobs
             WHERE owner_id=? AND status IN ('queued', 'running')
            """,
            (owner_id,),
        ).fetchall()
    for row in rows:
        try:
            payload = json.loads(row["payload_json"])
        except Exception:
            continue
        for item in payload.get("references") or []:
            if isinstance(item, dict) and item.get("location_id"):
                protected.add(str(item["location_id"]))
    return protected


def active_media_ids(owner_id: str | None = None) -> set[str]:
    protected: set[str] = set()
    with connect() as conn:
        if owner_id is None:
            rows = conn.execute(
                "SELECT payload_json FROM jobs WHERE status IN ('queued', 'running')"
            ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT payload_json
                  FROM jobs
                 WHERE owner_id=? AND status IN ('queued', 'running')
                """,
                (owner_id,),
            ).fetchall()
    for row in rows:
        try:
            payload = json.loads(row["payload_json"])
        except Exception:
            continue
        media_id = payload.get("media_id")
        if media_id:
            protected.add(str(media_id))
        for clip in payload.get("clips") or []:
            if isinstance(clip, dict) and clip.get("media_id"):
                protected.add(str(clip["media_id"]))
    return protected


def clear_media_except(
    exclude_ids: set[str] | None = None,
    owner_id: str | None = None,
) -> list[dict[str, Any]]:
    exclude_ids = {str(value) for value in (exclude_ids or set())}
    with connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        if owner_id is None:
            rows = conn.execute(
                "SELECT * FROM media ORDER BY created_at DESC"
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM media WHERE owner_id=? ORDER BY created_at DESC",
                (owner_id,),
            ).fetchall()
        delete_ids = [row["id"] for row in rows if row["id"] not in exclude_ids]
        if delete_ids:
            placeholders = ",".join("?" for _ in delete_ids)
            conn.execute(
                f"DELETE FROM media WHERE id IN ({placeholders})",
                delete_ids,
            )
        conn.execute("COMMIT")
    return [_decode_media(row) for row in rows if row["id"] in delete_ids]


def insert_character(
    *,
    character_id: str,
    owner_id: str,
    name: str,
    description: str,
    images: list[str],
    voice_file: str | None,
    voice_preset_id: str | None,
) -> None:
    now = utcnow()
    with connect() as conn:
        conn.execute(
            """
            INSERT INTO characters(
                id, owner_id, name, description, images_json, voice_file,
                voice_preset_id, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                character_id,
                owner_id,
                name,
                description,
                json.dumps(images, ensure_ascii=False),
                voice_file,
                voice_preset_id,
                now,
                now,
            ),
        )


def list_characters(owner_id: str) -> list[dict[str, Any]]:
    with connect() as conn:
        rows = conn.execute(
            """
            SELECT *
              FROM characters
             WHERE owner_id=?
             ORDER BY created_at DESC
            """,
            (owner_id,),
        ).fetchall()
    return [_decode_character(row) for row in rows]


def get_character(character_id: str, owner_id: str) -> dict[str, Any] | None:
    with connect() as conn:
        row = conn.execute(
            "SELECT * FROM characters WHERE id=? AND owner_id=?",
            (character_id, owner_id),
        ).fetchone()
    return _decode_character(row) if row else None


def update_character(
    character_id: str,
    owner_id: str,
    *,
    name: str,
    description: str,
    images: list[str],
    voice_file: str | None,
    voice_preset_id: str | None,
) -> dict[str, Any] | None:
    with connect() as conn:
        cur = conn.execute(
            """
            UPDATE characters
               SET name=?, description=?, images_json=?, voice_file=?,
                   voice_preset_id=?, updated_at=?
             WHERE id=? AND owner_id=?
            """,
            (
                name,
                description,
                json.dumps(images, ensure_ascii=False),
                voice_file,
                voice_preset_id,
                utcnow(),
                character_id,
                owner_id,
            ),
        )
        if cur.rowcount == 0:
            return None
    return get_character(character_id, owner_id)


def delete_character(character_id: str, owner_id: str) -> dict[str, Any] | None:
    with connect() as conn:
        row = conn.execute(
            "SELECT * FROM characters WHERE id=? AND owner_id=?",
            (character_id, owner_id),
        ).fetchone()
        if row is None:
            return None
        conn.execute(
            "DELETE FROM characters WHERE id=? AND owner_id=?",
            (character_id, owner_id),
        )
    return _decode_character(row)


def insert_location(
    *,
    location_id: str,
    owner_id: str,
    name: str,
    prompt: str,
    images: list[str],
) -> None:
    now = utcnow()
    with connect() as conn:
        conn.execute(
            """
            INSERT INTO locations(
                id, owner_id, name, prompt, images_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                location_id,
                owner_id,
                name,
                prompt,
                json.dumps(images, ensure_ascii=False),
                now,
                now,
            ),
        )


def list_locations(owner_id: str) -> list[dict[str, Any]]:
    with connect() as conn:
        rows = conn.execute(
            """
            SELECT *
              FROM locations
             WHERE owner_id=?
             ORDER BY created_at DESC
            """,
            (owner_id,),
        ).fetchall()
    return [_decode_location(row) for row in rows]


def get_location(location_id: str, owner_id: str) -> dict[str, Any] | None:
    with connect() as conn:
        row = conn.execute(
            "SELECT * FROM locations WHERE id=? AND owner_id=?",
            (location_id, owner_id),
        ).fetchone()
    return _decode_location(row) if row else None


def update_location(
    location_id: str,
    owner_id: str,
    *,
    name: str,
    prompt: str,
    images: list[str],
) -> dict[str, Any] | None:
    with connect() as conn:
        cur = conn.execute(
            """
            UPDATE locations
               SET name=?, prompt=?, images_json=?, updated_at=?
             WHERE id=? AND owner_id=?
            """,
            (
                name,
                prompt,
                json.dumps(images, ensure_ascii=False),
                utcnow(),
                location_id,
                owner_id,
            ),
        )
        if cur.rowcount == 0:
            return None
    return get_location(location_id, owner_id)


def delete_location(location_id: str, owner_id: str) -> dict[str, Any] | None:
    with connect() as conn:
        row = conn.execute(
            "SELECT * FROM locations WHERE id=? AND owner_id=?",
            (location_id, owner_id),
        ).fetchone()
        if row is None:
            return None
        conn.execute(
            "DELETE FROM locations WHERE id=? AND owner_id=?",
            (location_id, owner_id),
        )
    return _decode_location(row)


def state_counts(owner_id: str | None = None) -> dict[str, int]:
    with connect() as conn:
        if owner_id is None:
            queued = conn.execute(
                "SELECT COUNT(*) FROM jobs WHERE status='queued'"
            ).fetchone()[0]
            running = conn.execute(
                "SELECT COUNT(*) FROM jobs WHERE status='running'"
            ).fetchone()[0]
            media_count = conn.execute("SELECT COUNT(*) FROM media").fetchone()[0]
        else:
            queued = conn.execute(
                "SELECT COUNT(*) FROM jobs WHERE owner_id=? AND status='queued'",
                (owner_id,),
            ).fetchone()[0]
            running = conn.execute(
                "SELECT COUNT(*) FROM jobs WHERE owner_id=? AND status='running'",
                (owner_id,),
            ).fetchone()[0]
            media_count = conn.execute(
                "SELECT COUNT(*) FROM media WHERE owner_id=?",
                (owner_id,),
            ).fetchone()[0]
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


def _decode_character(row: sqlite3.Row) -> dict[str, Any]:
    item = dict(row)
    try:
        images = json.loads(item.pop("images_json"))
        item["images"] = [str(value) for value in images if value]
    except Exception:
        item["images"] = []
        item.pop("images_json", None)
    return item


def _decode_location(row: sqlite3.Row) -> dict[str, Any]:
    item = dict(row)
    try:
        images = json.loads(item.pop("images_json"))
        item["images"] = [str(value) for value in images if value]
    except Exception:
        item["images"] = []
        item.pop("images_json", None)
    return item
