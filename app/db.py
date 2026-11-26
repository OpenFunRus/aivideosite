from __future__ import annotations

import json
import shutil
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
                image_names_json TEXT NOT NULL DEFAULT '[]',
                voice_file TEXT,
                voice_preset_id TEXT,
                voice_name TEXT,
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
                image_names_json TEXT NOT NULL DEFAULT '[]',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_locations_owner_created
                ON locations(owner_id, created_at DESC);

            CREATE TABLE IF NOT EXISTS misc_presets (
                id TEXT PRIMARY KEY,
                owner_id TEXT NOT NULL,
                name TEXT NOT NULL,
                category TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                images_json TEXT NOT NULL DEFAULT '[]',
                image_names_json TEXT NOT NULL DEFAULT '[]',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_misc_presets_owner_created
                ON misc_presets(owner_id, created_at DESC);

            CREATE TABLE IF NOT EXISTS jobs (
                id TEXT PRIMARY KEY,
                owner_id TEXT NOT NULL DEFAULT 'user1',
                kind TEXT NOT NULL,
                gpu_target TEXT,
                status TEXT NOT NULL,
                progress REAL NOT NULL DEFAULT 0,
                stage TEXT NOT NULL DEFAULT '',
                payload_json TEXT NOT NULL,
                result_media_id TEXT,
                error TEXT,
                created_at TEXT NOT NULL,
                started_at TEXT,
                sampling_started_at TEXT,
                finished_at TEXT,
                external_id TEXT,
                cancel_requested INTEGER NOT NULL DEFAULT 0,
                preview_step INTEGER NOT NULL DEFAULT 0,
                preview_mime TEXT,
                preview_enabled INTEGER NOT NULL DEFAULT 0,
                test_paused INTEGER NOT NULL DEFAULT 0,
                test_paused_at TEXT,
                test_paused_seconds REAL NOT NULL DEFAULT 0,
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
        _ensure_reference_name_columns(conn)
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_jobs_owner_created "
            "ON jobs(owner_id, created_at DESC)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_media_owner_created "
            "ON media(owner_id, created_at DESC)"
        )
        # V2 is the only supported UI. Purge job kinds that belonged to retired
        # V1 generators/edit actions so they cannot remain queued after an upgrade.
        legacy_image_table = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='image_results'"
        ).fetchone()
        conn.execute(
            "DELETE FROM jobs WHERE kind IN ('image_generate','audio_replace','audio_remove')"
        )
        if legacy_image_table is not None:
            conn.execute("DROP TABLE image_results")

    if legacy_image_table is not None:
        shutil.rmtree(settings.data_dir / "images", ignore_errors=True)


def _ensure_jobs_columns(conn: sqlite3.Connection) -> None:
    columns = {row["name"] for row in conn.execute("PRAGMA table_info(jobs)").fetchall()}
    if "external_id" not in columns:
        conn.execute("ALTER TABLE jobs ADD COLUMN external_id TEXT")
    if "cancel_requested" not in columns:
        conn.execute(
            "ALTER TABLE jobs ADD COLUMN cancel_requested INTEGER NOT NULL DEFAULT 0"
        )
    if "gpu_target" not in columns:
        conn.execute("ALTER TABLE jobs ADD COLUMN gpu_target TEXT")
    if "preview_step" not in columns:
        conn.execute("ALTER TABLE jobs ADD COLUMN preview_step INTEGER NOT NULL DEFAULT 0")
    if "preview_mime" not in columns:
        conn.execute("ALTER TABLE jobs ADD COLUMN preview_mime TEXT")
    if "preview_enabled" not in columns:
        conn.execute("ALTER TABLE jobs ADD COLUMN preview_enabled INTEGER NOT NULL DEFAULT 0")
    if "test_paused" not in columns:
        conn.execute("ALTER TABLE jobs ADD COLUMN test_paused INTEGER NOT NULL DEFAULT 0")
    if "test_paused_at" not in columns:
        conn.execute("ALTER TABLE jobs ADD COLUMN test_paused_at TEXT")
    if "test_paused_seconds" not in columns:
        conn.execute("ALTER TABLE jobs ADD COLUMN test_paused_seconds REAL NOT NULL DEFAULT 0")
    if "sampling_started_at" not in columns:
        conn.execute("ALTER TABLE jobs ADD COLUMN sampling_started_at TEXT")


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


def _ensure_reference_name_columns(conn: sqlite3.Connection) -> None:
    for table in ("characters", "locations", "misc_presets"):
        columns = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}
        if "image_names_json" not in columns:
            conn.execute(
                f"ALTER TABLE {table} ADD COLUMN image_names_json TEXT NOT NULL DEFAULT '[]'"
            )
        if table == "characters" and "voice_name" not in columns:
            conn.execute("ALTER TABLE characters ADD COLUMN voice_name TEXT")


def interrupted_test_pauses() -> list[str]:
    """Identify blocked samplers before startup resets their persisted state."""
    with connect() as conn:
        rows = conn.execute(
            "SELECT id FROM jobs WHERE status='running' AND test_paused=1"
        ).fetchall()
    return [str(row["id"]) for row in rows]


def recover_interrupted_jobs() -> int:
    with connect() as conn:
        cur = conn.execute(
            """
            UPDATE jobs
               SET status='queued',
                   stage='Восстановлено после перезапуска',
                   progress=0,
                   started_at=NULL,
                   sampling_started_at=NULL,
                   external_id=NULL,
                   cancel_requested=0,
                   preview_step=0,
                   preview_mime=NULL,
                   preview_enabled=0,
                   test_paused=0,
                   test_paused_at=NULL,
                   test_paused_seconds=0,
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
    gpu_target: str | None = None,
) -> None:
    with connect() as conn:
        conn.execute(
            """
            INSERT INTO jobs(
                id, owner_id, kind, gpu_target, status, progress, stage, payload_json,
                created_at, external_id, cancel_requested
            ) VALUES (?, ?, ?, ?, 'queued', 0, 'В очереди', ?, ?, NULL, 0)
            """,
            (
                job_id,
                owner_id,
                kind,
                gpu_target,
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
        gpu_target=str(source.get("gpu_target")) if source.get("gpu_target") else None,
    )
    return source


def claim_next_job(
    kinds: set[str] | None = None,
    *,
    gpu_target: str | None = None,
    allow_unassigned: bool = False,
) -> dict[str, Any] | None:
    with connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        params:list[Any]=[]; clauses=["status='queued'","cancel_requested=0"]
        if kinds:
            ordered=sorted(kinds); clauses.append(f"kind IN ({','.join('?' for _ in ordered)})"); params.extend(ordered)
        if gpu_target:
            clauses.append("(gpu_target=? OR gpu_target IS NULL OR gpu_target='')" if allow_unassigned else "gpu_target=?")
            params.append(str(gpu_target))
        row=conn.execute(f"SELECT * FROM jobs WHERE {' AND '.join(clauses)} ORDER BY created_at ASC LIMIT 1",params).fetchone()
        if row is None:conn.execute("COMMIT"); return None
        started_at=utcnow()
        conn.execute("""UPDATE jobs SET status='running',stage='Запуск',progress=1,started_at=?,external_id=NULL,
                        sampling_started_at=NULL,
                        cancel_requested=0,preview_step=0,preview_mime=NULL,preview_enabled=0,
                        test_paused=0,test_paused_at=NULL,test_paused_seconds=0,error=NULL WHERE id=?""",(started_at,row["id"]))
        conn.execute("COMMIT")
    result=_decode_job(row); result["status"]="running"; result["started_at"]=started_at; result["cancel_requested"]=0
    return result


def mark_sampling_started(job_id: str) -> bool:
    """Capture the first real ComfyUI sampler progress event, exactly once."""
    with connect() as conn:
        updated = conn.execute(
            """UPDATE jobs SET sampling_started_at=?
               WHERE id=? AND kind='generate' AND status='running'
                 AND cancel_requested=0 AND sampling_started_at IS NULL""",
            (utcnow(), job_id),
        )
        return updated.rowcount == 1


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
                       preview_step=0,
                       preview_mime=NULL,
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
                       preview_step=0,
                       preview_mime=NULL,
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
                   preview_step=0,
                   preview_mime=NULL,
                   finished_at=?,
                   error=NULL
             WHERE id=?
            """,
            (utcnow(), job_id),
        )


def complete_job(job_id: str, media_id: str | None = None) -> bool:
    with connect() as conn:
        result = conn.execute(
            """
            UPDATE jobs
               SET status='done',
                   progress=100,
                   stage='Готово',
                   result_media_id=?,
                   finished_at=?,
                   cancel_requested=0,
                   preview_step=0,
                   preview_mime=NULL
             WHERE id=? AND status='running' AND cancel_requested=0
            """,
            (media_id, utcnow(), job_id),
        )
    return result.rowcount == 1


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
                   preview_step=0,
                   preview_mime=NULL,
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


def list_active_generation_jobs(owner_id: str, limit: int = 100) -> list[dict[str, Any]]:
    with connect() as conn:
        rows = conn.execute(
            """SELECT * FROM jobs
               WHERE owner_id=? AND kind='generate'
                 AND status IN ('queued', 'running') AND cancel_requested=0
               ORDER BY created_at DESC LIMIT ?""",
            (owner_id, max(1, min(100, limit))),
        ).fetchall()
    return [_decode_job(row) for row in rows]


def prune_job_history(
    owner_id: str,
    keep: int = 20,
) -> list[dict[str, Any]]:
    keep = max(1, int(keep))
    with connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        rows = conn.execute(
            """
            SELECT *
              FROM jobs
             WHERE owner_id=?
             ORDER BY created_at DESC
             LIMIT -1 OFFSET ?
            """,
            (owner_id, keep),
        ).fetchall()
        removable = [
            row
            for row in rows
            if row["status"] not in {"queued", "running"}
        ]
        if removable:
            conn.executemany(
                "DELETE FROM jobs WHERE id=? AND owner_id=?",
                [(row["id"], owner_id) for row in removable],
            )
        conn.execute("COMMIT")
    return [_decode_job(row) for row in removable]


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


def active_gpu_reservations() -> dict[str, str]:
    result={}
    with connect() as conn:
        rows=conn.execute("""SELECT id,gpu_target FROM jobs WHERE status IN ('queued','running')
                             AND gpu_target IS NOT NULL AND gpu_target!='' ORDER BY created_at ASC""").fetchall()
    for row in rows:
        target=str(row["gpu_target"] or "").strip()
        if target and target not in result:result[target]=str(row["id"])
    return result

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



def active_misc_ids(owner_id: str) -> set[str]:
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
            if isinstance(item, dict) and item.get("misc_id"):
                protected.add(str(item["misc_id"]))
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
        second_media_id = payload.get("second_media_id")
        if second_media_id:
            protected.add(str(second_media_id))
        repair = payload.get("repair") if isinstance(payload.get("repair"), dict) else {}
        for key in ("media_id", "second_media_id"):
            if repair.get(key):
                protected.add(str(repair[key]))
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
    image_names: list[str],
    voice_file: str | None,
    voice_preset_id: str | None,
    voice_name: str | None,
) -> None:
    now = utcnow()
    with connect() as conn:
        conn.execute(
            """
            INSERT INTO characters(
                id, owner_id, name, description, images_json, image_names_json,
                voice_file, voice_preset_id, voice_name, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                character_id,
                owner_id,
                name,
                description,
                json.dumps(images, ensure_ascii=False),
                json.dumps(image_names, ensure_ascii=False),
                voice_file,
                voice_preset_id,
                voice_name,
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
    image_names: list[str | None],
    voice_file: str | None,
    voice_preset_id: str | None,
    voice_name: str | None,
) -> dict[str, Any] | None:
    with connect() as conn:
        cur = conn.execute(
            """
            UPDATE characters
               SET name=?, description=?, images_json=?, image_names_json=?,
                   voice_file=?, voice_preset_id=?, voice_name=?, updated_at=?
             WHERE id=? AND owner_id=?
            """,
            (
                name,
                description,
                json.dumps(images, ensure_ascii=False),
                json.dumps(image_names, ensure_ascii=False),
                voice_file,
                voice_preset_id,
                voice_name,
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
    image_names: list[str],
) -> None:
    now = utcnow()
    with connect() as conn:
        conn.execute(
            """
            INSERT INTO locations(
                id, owner_id, name, prompt, images_json, image_names_json,
                created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                location_id,
                owner_id,
                name,
                prompt,
                json.dumps(images, ensure_ascii=False),
                json.dumps(image_names, ensure_ascii=False),
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
    image_names: list[str | None],
) -> dict[str, Any] | None:
    with connect() as conn:
        cur = conn.execute(
            """
            UPDATE locations
               SET name=?, prompt=?, images_json=?, image_names_json=?, updated_at=?
             WHERE id=? AND owner_id=?
            """,
            (
                name,
                prompt,
                json.dumps(images, ensure_ascii=False),
                json.dumps(image_names, ensure_ascii=False),
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



def insert_misc_preset(
    *,
    misc_id: str,
    owner_id: str,
    name: str,
    category: str,
    description: str,
    images: list[str],
    image_names: list[str],
) -> None:
    now = utcnow()
    with connect() as conn:
        conn.execute(
            """
            INSERT INTO misc_presets(
                id, owner_id, name, category, description, images_json,
                image_names_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                misc_id,
                owner_id,
                name,
                category,
                description,
                json.dumps(images, ensure_ascii=False),
                json.dumps(image_names, ensure_ascii=False),
                now,
                now,
            ),
        )


def list_misc_presets(owner_id: str) -> list[dict[str, Any]]:
    with connect() as conn:
        rows = conn.execute(
            """
            SELECT *
              FROM misc_presets
             WHERE owner_id=?
             ORDER BY created_at DESC
            """,
            (owner_id,),
        ).fetchall()
    return [_decode_misc_preset(row) for row in rows]


def get_misc_preset(misc_id: str, owner_id: str) -> dict[str, Any] | None:
    with connect() as conn:
        row = conn.execute(
            "SELECT * FROM misc_presets WHERE id=? AND owner_id=?",
            (misc_id, owner_id),
        ).fetchone()
    return _decode_misc_preset(row) if row else None


def update_misc_preset(
    misc_id: str,
    owner_id: str,
    *,
    name: str,
    category: str,
    description: str,
    images: list[str],
    image_names: list[str | None],
) -> dict[str, Any] | None:
    with connect() as conn:
        cur = conn.execute(
            """
            UPDATE misc_presets
               SET name=?, category=?, description=?, images_json=?, image_names_json=?, updated_at=?
             WHERE id=? AND owner_id=?
            """,
            (
                name,
                category,
                description,
                json.dumps(images, ensure_ascii=False),
                json.dumps(image_names, ensure_ascii=False),
                utcnow(),
                misc_id,
                owner_id,
            ),
        )
        if cur.rowcount == 0:
            return None
    return get_misc_preset(misc_id, owner_id)


def delete_misc_preset(misc_id: str, owner_id: str) -> dict[str, Any] | None:
    with connect() as conn:
        row = conn.execute(
            "SELECT * FROM misc_presets WHERE id=? AND owner_id=?",
            (misc_id, owner_id),
        ).fetchone()
        if row is None:
            return None
        conn.execute(
            "DELETE FROM misc_presets WHERE id=? AND owner_id=?",
            (misc_id, owner_id),
        )
    return _decode_misc_preset(row)


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


def _decode_reference_images(item: dict[str, Any]) -> None:
    try:
        images = json.loads(item.pop("images_json"))
        item["images"] = [str(value) for value in images if value]
    except (ValueError, TypeError):
        item["images"] = []
        item.pop("images_json", None)
    try:
        names = json.loads(item.pop("image_names_json"))
        if not isinstance(names, list):
            names = []
    except (ValueError, TypeError):
        names = []
        item.pop("image_names_json", None)
    item["image_names"] = [
        str(names[index]) if index < len(names) and names[index] else None
        for index in range(len(item["images"]))
    ]


def _decode_character(row: sqlite3.Row) -> dict[str, Any]:
    item = dict(row)
    _decode_reference_images(item)
    return item



def _decode_misc_preset(row: sqlite3.Row) -> dict[str, Any]:
    item = dict(row)
    _decode_reference_images(item)
    return item


def _decode_location(row: sqlite3.Row) -> dict[str, Any]:
    item = dict(row)
    _decode_reference_images(item)
    return item
