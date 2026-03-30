"""
Navvi persistent store — SQLite-backed persona config, state, and action log.

Schema:
  personas: config + runtime state (name, description, purpose, stealth, locale, timezone, etc.)
  accounts: credential references per persona (service, email, gopass ref, status)
  actions:  append-only action log per persona (timestamped events)
  milestones: curated lifetime timeline per persona (events with evidence)
  persona_context: persistent knowledge store per persona (what a persona knows)
"""

import datetime
import json
import sqlite3
import time
from pathlib import Path
from typing import Optional


def _db_path() -> str:
    """Resolve DB path: ~/.navvi/navvi.db"""
    navvi_dir = Path.home() / ".navvi"
    navvi_dir.mkdir(parents=True, exist_ok=True)
    return str(navvi_dir / "navvi.db")


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(_db_path())
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


BASE_API_PORT = 8024
BASE_VNC_PORT = 6080


def init_db():
    """Create tables if they don't exist."""
    conn = _connect()
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS personas (
            name TEXT PRIMARY KEY,
            description TEXT DEFAULT '',
            purpose TEXT DEFAULT '',
            stealth TEXT DEFAULT 'high',
            locale TEXT DEFAULT 'en-US',
            timezone TEXT DEFAULT 'UTC',
            viewport TEXT DEFAULT '1024x768',
            profile TEXT DEFAULT '',
            created_at REAL NOT NULL,
            last_used_at REAL,
            api_port INTEGER,
            vnc_port INTEGER
        );

        CREATE TABLE IF NOT EXISTS accounts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            persona TEXT NOT NULL REFERENCES personas(name) ON DELETE CASCADE,
            service TEXT NOT NULL,
            email TEXT DEFAULT '',
            creds_ref TEXT DEFAULT '',
            status TEXT DEFAULT 'active',
            created_at REAL NOT NULL,
            notes TEXT DEFAULT ''
        );

        CREATE TABLE IF NOT EXISTS actions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            persona TEXT NOT NULL REFERENCES personas(name) ON DELETE CASCADE,
            action TEXT NOT NULL,
            detail TEXT DEFAULT '',
            ts REAL NOT NULL
        );

        CREATE TABLE IF NOT EXISTS flows (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            domain TEXT NOT NULL,
            action TEXT NOT NULL,
            description TEXT DEFAULT '',
            confidence INTEGER DEFAULT 0,
            steps TEXT DEFAULT '[]',
            caveats TEXT DEFAULT '[]',
            refs TEXT DEFAULT '[]',
            created TEXT NOT NULL,
            last_verified TEXT DEFAULT '',
            last_failed TEXT DEFAULT '',
            UNIQUE(domain, action)
        );

        CREATE TABLE IF NOT EXISTS milestones (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            persona TEXT NOT NULL REFERENCES personas(name) ON DELETE CASCADE,
            event TEXT NOT NULL,
            detail TEXT DEFAULT '',
            url TEXT DEFAULT '',
            tags TEXT DEFAULT '[]',
            screenshot_path TEXT DEFAULT '',
            source TEXT DEFAULT 'manual',
            ts REAL NOT NULL
        );

        CREATE TABLE IF NOT EXISTS persona_context (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            persona TEXT NOT NULL REFERENCES personas(name) ON DELETE CASCADE,
            summary TEXT NOT NULL,
            source TEXT,
            tags TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT,
            digested_at TEXT,
            deleted_at TEXT
        );
    """)
    conn.commit()
    # Migrate: add port columns if missing (existing DBs)
    try:
        conn.execute("SELECT api_port FROM personas LIMIT 1")
    except sqlite3.OperationalError:
        conn.execute("ALTER TABLE personas ADD COLUMN api_port INTEGER")
        conn.execute("ALTER TABLE personas ADD COLUMN vnc_port INTEGER")
        conn.commit()
    # Migrate: add profile column if missing (existing DBs)
    try:
        conn.execute("SELECT profile FROM personas LIMIT 1")
    except sqlite3.OperationalError:
        conn.execute("ALTER TABLE personas ADD COLUMN profile TEXT DEFAULT ''")
        conn.commit()
    # Migrate: add context_summary column if missing (existing DBs)
    try:
        conn.execute("SELECT context_summary FROM personas LIMIT 1")
    except sqlite3.OperationalError:
        conn.execute("ALTER TABLE personas ADD COLUMN context_summary TEXT DEFAULT ''")
        conn.commit()
    conn.close()


# --- Port allocation ---

def allocate_ports(persona: str) -> dict:
    """Allocate unique API + VNC ports for a persona. Returns {api: int, vnc: int}."""
    conn = _connect()
    # Check if already allocated
    row = conn.execute("SELECT api_port, vnc_port FROM personas WHERE name = ?", (persona,)).fetchone()
    if row and row["api_port"]:
        ports = {"api": row["api_port"], "vnc": row["vnc_port"]}
        conn.close()
        return ports
    # Find next free port pair
    used = conn.execute("SELECT api_port FROM personas WHERE api_port IS NOT NULL").fetchall()
    used_ports = {r["api_port"] for r in used}
    offset = 0
    while (BASE_API_PORT + offset) in used_ports:
        offset += 1
    api_port = BASE_API_PORT + offset
    vnc_port = BASE_VNC_PORT + offset
    conn.execute("UPDATE personas SET api_port = ?, vnc_port = ? WHERE name = ?", (api_port, vnc_port, persona))
    conn.commit()
    conn.close()
    return {"api": api_port, "vnc": vnc_port}


def release_ports(persona: str):
    """Release allocated ports for a persona."""
    conn = _connect()
    conn.execute("UPDATE personas SET api_port = NULL, vnc_port = NULL WHERE name = ?", (persona,))
    conn.commit()
    conn.close()


def get_persona_ports(persona: str) -> Optional[dict]:
    """Get allocated ports for a persona, or None if not allocated."""
    conn = _connect()
    row = conn.execute("SELECT api_port, vnc_port FROM personas WHERE name = ?", (persona,)).fetchone()
    conn.close()
    if row and row["api_port"]:
        return {"api": row["api_port"], "vnc": row["vnc_port"]}
    return None


# --- Persona CRUD ---

def create_persona(
    name: str,
    description: str = "",
    purpose: str = "",
    stealth: str = "high",
    locale: str = "en-US",
    timezone: str = "UTC",
    viewport: str = "1024x768",
    profile: str = "",
) -> dict:
    conn = _connect()
    now = time.time()
    try:
        conn.execute(
            "INSERT INTO personas (name, description, purpose, stealth, locale, timezone, viewport, profile, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (name, description, purpose, stealth, locale, timezone, viewport, profile, now),
        )
        conn.commit()
    except sqlite3.IntegrityError:
        conn.close()
        raise ValueError(f"Persona '{name}' already exists. Use update to modify.")
    conn.close()
    return get_persona(name)


def get_persona(name: str) -> Optional[dict]:
    conn = _connect()
    row = conn.execute("SELECT * FROM personas WHERE name = ?", (name,)).fetchone()
    conn.close()
    if not row:
        return None
    return dict(row)


def update_persona(name: str, **kwargs) -> dict:
    conn = _connect()
    existing = conn.execute("SELECT * FROM personas WHERE name = ?", (name,)).fetchone()
    if not existing:
        conn.close()
        raise ValueError(f"Persona '{name}' not found.")
    allowed = {"description", "purpose", "stealth", "locale", "timezone", "viewport", "profile"}
    updates = {k: v for k, v in kwargs.items() if k in allowed and v is not None}
    if not updates:
        conn.close()
        return dict(existing)
    set_clause = ", ".join(f"{k} = ?" for k in updates)
    values = list(updates.values()) + [name]
    conn.execute(f"UPDATE personas SET {set_clause} WHERE name = ?", values)
    conn.commit()
    conn.close()
    return get_persona(name)


def delete_persona(name: str) -> bool:
    conn = _connect()
    cursor = conn.execute("DELETE FROM personas WHERE name = ?", (name,))
    conn.commit()
    conn.close()
    return cursor.rowcount > 0


def list_personas() -> list:
    conn = _connect()
    rows = conn.execute("SELECT * FROM personas ORDER BY created_at").fetchall()
    conn.close()
    return [dict(r) for r in rows]


def touch_persona(name: str):
    """Update last_used_at timestamp."""
    conn = _connect()
    conn.execute("UPDATE personas SET last_used_at = ? WHERE name = ?", (time.time(), name))
    conn.commit()
    conn.close()


# --- Ensure default persona exists ---

def ensure_default():
    """Create 'default' persona if it doesn't exist."""
    if not get_persona("default"):
        create_persona(name="default", description="Default browser persona")


# --- Accounts ---

def add_account(
    persona: str,
    service: str,
    email: str = "",
    creds_ref: str = "",
    status: str = "active",
    notes: str = "",
) -> dict:
    conn = _connect()
    now = time.time()
    cursor = conn.execute(
        "INSERT INTO accounts (persona, service, email, creds_ref, status, created_at, notes) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (persona, service, email, creds_ref, status, now, notes),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM accounts WHERE id = ?", (cursor.lastrowid,)).fetchone()
    conn.close()
    return dict(row)


def list_accounts(persona: str) -> list:
    conn = _connect()
    rows = conn.execute("SELECT * FROM accounts WHERE persona = ? ORDER BY created_at", (persona,)).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def update_account(account_id: int, **kwargs) -> dict:
    conn = _connect()
    allowed = {"service", "email", "creds_ref", "status", "notes"}
    updates = {k: v for k, v in kwargs.items() if k in allowed and v is not None}
    if updates:
        set_clause = ", ".join(f"{k} = ?" for k in updates)
        values = list(updates.values()) + [account_id]
        conn.execute(f"UPDATE accounts SET {set_clause} WHERE id = ?", values)
        conn.commit()
    row = conn.execute("SELECT * FROM accounts WHERE id = ?", (account_id,)).fetchone()
    conn.close()
    return dict(row) if row else {}


def delete_account(account_id: int) -> bool:
    conn = _connect()
    cursor = conn.execute("DELETE FROM accounts WHERE id = ?", (account_id,))
    conn.commit()
    conn.close()
    return cursor.rowcount > 0


# --- Action Log ---

def log_persona_action(persona: str, action: str, detail: str = ""):
    conn = _connect()
    conn.execute(
        "INSERT INTO actions (persona, action, detail, ts) VALUES (?, ?, ?, ?)",
        (persona, action, detail, time.time()),
    )
    conn.commit()
    conn.close()


def get_recent_actions(persona: str, limit: int = 20) -> list:
    conn = _connect()
    rows = conn.execute(
        "SELECT * FROM actions WHERE persona = ? ORDER BY ts DESC LIMIT ?",
        (persona, limit),
    ).fetchall()
    conn.close()
    return [dict(r) for r in reversed(rows)]


# --- Milestones (lifetime timeline) ---

def _timeline_dir(persona: str) -> Path:
    """Persistent screenshot dir for milestones: ~/.navvi/{persona}/timeline/"""
    d = Path.home() / ".navvi" / persona / "timeline"
    d.mkdir(parents=True, exist_ok=True)
    return d


def add_milestone(
    persona: str,
    event: str,
    detail: str = "",
    url: str = "",
    tags: list = None,
    screenshot_path: str = "",
    source: str = "manual",
    ts: float = None,
) -> dict:
    conn = _connect()
    now = ts or time.time()
    tags_json = json.dumps(tags or [])
    cursor = conn.execute(
        "INSERT INTO milestones (persona, event, detail, url, tags, screenshot_path, source, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (persona, event, detail, url, tags_json, screenshot_path, source, now),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM milestones WHERE id = ?", (cursor.lastrowid,)).fetchone()
    conn.close()
    return _milestone_to_dict(row)


def list_milestones(persona: str, tag: str = None, limit: int = 0) -> list:
    conn = _connect()
    if tag:
        rows = conn.execute(
            "SELECT * FROM milestones WHERE persona = ? AND tags LIKE ? ORDER BY ts",
            (persona, f'%"{tag}"%'),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM milestones WHERE persona = ? ORDER BY ts",
            (persona,),
        ).fetchall()
    conn.close()
    results = [_milestone_to_dict(r) for r in rows]
    if limit > 0:
        results = results[-limit:]
    return results


def delete_milestone(milestone_id: int) -> bool:
    conn = _connect()
    cursor = conn.execute("DELETE FROM milestones WHERE id = ?", (milestone_id,))
    conn.commit()
    conn.close()
    return cursor.rowcount > 0


def export_timeline(persona: str, tag: str = None) -> str:
    """Generate a readable markdown timeline for a persona."""
    import datetime
    p = get_persona(persona)
    if not p:
        return f"Persona '{persona}' not found."

    milestones = list_milestones(persona, tag=tag)
    if not milestones:
        return f"No milestones recorded for '{persona}'."

    desc = f" — {p['description']}" if p['description'] else ""
    lines = [f"# {persona}{desc} — Timeline", ""]

    current_date = None
    for m in milestones:
        dt = datetime.datetime.fromtimestamp(m["ts"])
        date_str = dt.strftime("%Y-%m-%d")
        time_str = dt.strftime("%H:%M")

        if date_str != current_date:
            current_date = date_str
            lines.append(f"## {date_str}")
            lines.append("")

        tag_str = " ".join(f"`{t}`" for t in m["tags"]) if m["tags"] else ""
        lines.append(f"### {time_str} — {m['event']}")
        if tag_str:
            lines.append(f"Tags: {tag_str}")
        if m["url"]:
            lines.append(f"URL: {m['url']}")
        if m["detail"]:
            lines.append(f"\n{m['detail']}")
        if m["screenshot_path"]:
            lines.append(f"\n![{m['event']}]({m['screenshot_path']})")
        lines.append("")

    return "\n".join(lines)


def generate_brief(persona: str) -> str:
    """Generate a persona brief — a concise 'who am I' document for Claude sessions.

    Built from persona config, accounts, and milestones. Gives any fresh session
    enough context to act correctly as this persona (right email, right username,
    right voice, right history).
    """
    import datetime
    p = get_persona(persona)
    if not p:
        return f"Persona '{persona}' not found."

    lines = [f"# {persona} — Persona Brief", ""]

    # Voice & Writing Style (from profile)
    if p.get('profile'):
        lines.append("## Voice & Writing Style")
        lines.append("")
        lines.append(p['profile'])
        lines.append("")

    # Identity
    if p['description']:
        lines.append(f"**Who I am:** {p['description']}")
    if p['purpose']:
        lines.append(f"**Purpose:** {p['purpose']}")
    lines.append(f"**Location:** {p['locale']} / {p['timezone']}")
    lines.append(f"**Stealth:** {p['stealth']}")
    lines.append("")

    # Accounts — this is the critical part that prevents wrong-email bugs
    accounts = list_accounts(persona)
    if accounts:
        lines.append("## My Accounts")
        lines.append("")
        for a in accounts:
            status = f" ⚠️ {a['status']}" if a['status'] != 'active' else ""
            notes = f" — {a['notes']}" if a['notes'] else ""
            lines.append(f"- **{a['service']}**: {a['email']}{status}{notes}")
        lines.append("")
        # Extract primary email
        email_services = ('outlook', 'outlook.com', 'gmail', 'tutanota', 'protonmail', 'hotmail')
        email_accounts = [a for a in accounts if a['service'].lower() in email_services and a['status'] == 'active']
        if email_accounts:
            primary = email_accounts[0]
            lines.append(f"**⚡ My primary email: `{primary['email']}`** — use this when signing up for new services.")
            lines.append("")

    # Milestones summary — what I've done
    milestones = list_milestones(persona)
    if milestones:
        lines.append("## What I've Done")
        lines.append("")
        for m in milestones:
            dt = datetime.datetime.fromtimestamp(m["ts"])
            date_str = dt.strftime("%Y-%m-%d")
            tag_str = f" [{', '.join(m['tags'])}]" if m['tags'] else ""
            lines.append(f"- **{date_str}** — {m['event']}{tag_str}")
            # Include first 200 chars of detail for context
            if m['detail']:
                preview = m['detail'].split('\n')[0][:200]
                lines.append(f"  {preview}")
        lines.append("")

    # Writing style hints from milestone content
    posts = [m for m in milestones if any(t in (m.get('tags') or []) for t in ['comment', 'post', 'reply'])]
    if posts:
        lines.append("## My Writing Style")
        lines.append("")
        lines.append("Here are things I've written before — match this tone and style:")
        lines.append("")
        for m in posts[-3:]:  # last 3 posts
            if m['detail']:
                lines.append(f"**{m['event']}:**")
                lines.append(f"> {m['detail'][:500]}")
                lines.append("")

    # Context — what I know (curated digest)
    ctx_summary = get_context_summary(persona)
    if ctx_summary:
        lines.append("## What I Know")
        lines.append("")
        lines.append(ctx_summary)
        lines.append("")

    # Rules
    lines.append("## Rules")
    lines.append("")
    lines.append("- Always use my primary email when signing up for new services")
    lines.append("- Match my writing style from previous posts")
    lines.append("- Record milestones for significant actions (`navvi_milestone`)")
    lines.append("- Check my account list before creating duplicate accounts")

    brief = "\n".join(lines)

    # Save to file
    brief_path = Path.home() / ".navvi" / persona / "brief.md"
    brief_path.parent.mkdir(parents=True, exist_ok=True)
    brief_path.write_text(brief)

    return brief


def _milestone_to_dict(row) -> dict:
    d = dict(row)
    d["tags"] = json.loads(d.get("tags", "[]"))
    return d


# --- State resource (compact YAML-like summary) ---

def persona_state_summary(name: str) -> str:
    """Generate a compact state summary for the persona resource."""
    p = get_persona(name)
    if not p:
        return f"Persona '{name}' not found."

    lines = [
        f"persona: {p['name']}",
        f"description: {p['description']}" if p['description'] else None,
        f"purpose: {p['purpose']}" if p['purpose'] else None,
        f"stealth: {p['stealth']}",
        f"locale: {p['locale']}",
        f"timezone: {p['timezone']}",
        f"viewport: {p['viewport']}",
        f"profile: {p.get('profile', '')[:80]}..." if p.get('profile') else None,
        f"created: {_format_ts(p['created_at'])}",
        f"last_used: {_format_ts(p['last_used_at'])}" if p['last_used_at'] else None,
        f"docker_volume: navvi-profile-{p['name']}",
    ]

    accounts = list_accounts(name)
    if accounts:
        lines.append("")
        lines.append("accounts:")
        for a in accounts:
            status_suffix = f" ({a['status']})" if a['status'] != 'active' else ""
            creds = f" creds={a['creds_ref']}" if a['creds_ref'] else ""
            lines.append(f"  - {a['service']}: {a['email']}{creds}{status_suffix}")

    milestones = list_milestones(name)
    if milestones:
        lines.append("")
        lines.append(f"milestones: {len(milestones)} recorded")
        for m in milestones[-5:]:
            tag_str = f" [{', '.join(m['tags'])}]" if m['tags'] else ""
            lines.append(f"  - {_format_ts(m['ts'])} — {m['event']}{tag_str}")

    actions = get_recent_actions(name, limit=10)
    if actions:
        lines.append("")
        lines.append("recent_actions:")
        for a in actions:
            lines.append(f"  - {_format_ts(a['ts'])} — {a['action']}: {a['detail']}")

    return "\n".join(l for l in lines if l is not None)


def personas_list_summary() -> str:
    """Generate a compact list of all personas."""
    personas = list_personas()
    if not personas:
        return "No personas configured. Use navvi_persona to create one."
    lines = []
    for p in personas:
        acct_count = len(list_accounts(p['name']))
        last = _format_ts(p['last_used_at']) if p['last_used_at'] else "never"
        desc = f" — {p['description']}" if p['description'] else ""
        lines.append(f"- {p['name']}{desc} ({acct_count} accounts, last used: {last})")
    return "\n".join(lines)


def _format_ts(ts: Optional[float]) -> str:
    if not ts:
        return "never"
    return datetime.datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M")


# --- Persona Context (knowledge store) ---


def _now_iso() -> str:
    return datetime.datetime.now().isoformat()


def add_context(
    persona: str,
    summary: str,
    source: str = None,
    tags: str = None,
) -> dict:
    conn = _connect()
    now = _now_iso()
    cursor = conn.execute(
        "INSERT INTO persona_context (persona, summary, source, tags, created_at) VALUES (?, ?, ?, ?, ?)",
        (persona, summary, source, tags, now),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM persona_context WHERE id = ?", (cursor.lastrowid,)).fetchone()
    conn.close()
    return dict(row)


def list_context(persona: str, tags: str = None) -> list:
    conn = _connect()
    if tags:
        tag_list = [t.strip() for t in tags.split(",") if t.strip()]
        rows = conn.execute(
            "SELECT * FROM persona_context WHERE persona = ? AND deleted_at IS NULL ORDER BY created_at",
            (persona,),
        ).fetchall()
        conn.close()
        # Filter: entry must contain at least one of the requested tags
        results = []
        for r in rows:
            entry_tags = set(t.strip() for t in (r["tags"] or "").split(",") if t.strip())
            if entry_tags & set(tag_list):
                results.append(dict(r))
        return results
    else:
        rows = conn.execute(
            "SELECT * FROM persona_context WHERE persona = ? AND deleted_at IS NULL ORDER BY created_at",
            (persona,),
        ).fetchall()
        conn.close()
        return [dict(r) for r in rows]


def search_context(persona: str, query: str, tags: str = None) -> list:
    conn = _connect()
    rows = conn.execute(
        "SELECT * FROM persona_context WHERE persona = ? AND deleted_at IS NULL AND summary LIKE ? ORDER BY created_at",
        (persona, f"%{query}%"),
    ).fetchall()
    conn.close()
    results = [dict(r) for r in rows]
    if tags:
        tag_list = set(t.strip() for t in tags.split(",") if t.strip())
        results = [
            r for r in results
            if set(t.strip() for t in (r["tags"] or "").split(",") if t.strip()) & tag_list
        ]
    return results


def update_context(context_id: int, **kwargs) -> Optional[dict]:
    conn = _connect()
    allowed = {"summary", "source", "tags"}
    updates = {k: v for k, v in kwargs.items() if k in allowed and v is not None}
    if not updates:
        row = conn.execute("SELECT * FROM persona_context WHERE id = ?", (context_id,)).fetchone()
        conn.close()
        return dict(row) if row else None
    updates["updated_at"] = _now_iso()
    # Keep digested_at intact — the query `updated_at > digested_at` will
    # correctly identify this as "updated, needs re-digest". NULLing it would
    # make it appear as a new entry instead of an updated one.
    set_clause = ", ".join(f"{k} = ?" for k in updates)
    values = list(updates.values()) + [context_id]
    conn.execute(f"UPDATE persona_context SET {set_clause} WHERE id = ?", values)
    conn.commit()
    row = conn.execute("SELECT * FROM persona_context WHERE id = ?", (context_id,)).fetchone()
    conn.close()
    return dict(row) if row else None


def remove_context(context_id: int) -> bool:
    conn = _connect()
    now = _now_iso()
    cursor = conn.execute(
        "UPDATE persona_context SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL",
        (now, context_id),
    )
    conn.commit()
    conn.close()
    return cursor.rowcount > 0


def get_digest_ingredients(persona: str) -> dict:
    """Return current summary + entries needing digest (new, updated, deleted)."""
    conn = _connect()
    p = conn.execute("SELECT context_summary FROM personas WHERE name = ?", (persona,)).fetchone()
    current_summary = (p["context_summary"] or "") if p else ""

    # New: never digested, not deleted
    new_rows = conn.execute(
        "SELECT * FROM persona_context WHERE persona = ? AND digested_at IS NULL AND deleted_at IS NULL ORDER BY created_at",
        (persona,),
    ).fetchall()

    # Updated: digested_at < updated_at, not deleted
    updated_rows = conn.execute(
        "SELECT * FROM persona_context WHERE persona = ? AND digested_at IS NOT NULL AND updated_at IS NOT NULL AND updated_at > digested_at AND deleted_at IS NULL ORDER BY created_at",
        (persona,),
    ).fetchall()

    # Deleted: soft-deleted but not yet purged (digested_at doesn't matter)
    deleted_rows = conn.execute(
        "SELECT * FROM persona_context WHERE persona = ? AND deleted_at IS NOT NULL ORDER BY created_at",
        (persona,),
    ).fetchall()

    conn.close()
    return {
        "current_summary": current_summary,
        "new_entries": [dict(r) for r in new_rows],
        "updated_entries": [dict(r) for r in updated_rows],
        "deleted_entries": [dict(r) for r in deleted_rows],
    }


def save_digest(persona: str, summary: str) -> bool:
    """Store new digest summary, mark entries as digested, hard-delete soft-deleted."""
    conn = _connect()
    now = _now_iso()
    # Update persona summary
    conn.execute("UPDATE personas SET context_summary = ? WHERE name = ?", (summary, persona))
    # Mark all active undigested/updated entries as digested
    conn.execute(
        "UPDATE persona_context SET digested_at = ? WHERE persona = ? AND deleted_at IS NULL AND (digested_at IS NULL OR (updated_at IS NOT NULL AND updated_at > digested_at))",
        (now, persona),
    )
    # Hard-delete soft-deleted entries
    conn.execute("DELETE FROM persona_context WHERE persona = ? AND deleted_at IS NOT NULL", (persona,))
    conn.commit()
    conn.close()
    return True


def get_context_summary(persona: str) -> str:
    conn = _connect()
    row = conn.execute("SELECT context_summary FROM personas WHERE name = ?", (persona,)).fetchone()
    conn.close()
    return (row["context_summary"] or "") if row else ""


# --- Flows (recipe store) ---


def save_flow(
    domain: str,
    action: str,
    description: str = "",
    steps: list = None,
    caveats: list = None,
    refs: list = None,
    confidence: int = 1,
) -> dict:
    """Save or update a flow recipe. Upserts on (domain, action)."""
    import datetime
    conn = _connect()
    now = datetime.datetime.now().isoformat()
    steps_json = json.dumps(steps or [])
    caveats_json = json.dumps(caveats or [])
    refs_json = json.dumps(refs or [])

    existing = conn.execute(
        "SELECT id FROM flows WHERE domain = ? AND action = ?",
        (domain, action),
    ).fetchone()

    if existing:
        conn.execute(
            "UPDATE flows SET description = ?, steps = ?, caveats = ?, refs = ?, confidence = ?, last_verified = ? WHERE id = ?",
            (description, steps_json, caveats_json, refs_json, confidence, now, existing["id"]),
        )
    else:
        conn.execute(
            "INSERT INTO flows (domain, action, description, steps, caveats, refs, confidence, created, last_verified) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (domain, action, description, steps_json, caveats_json, refs_json, confidence, now, now),
        )
    conn.commit()
    conn.close()
    return get_flow(domain, action)


def get_flow(domain: str, action: str) -> Optional[dict]:
    conn = _connect()
    row = conn.execute(
        "SELECT * FROM flows WHERE domain = ? AND action = ?",
        (domain, action),
    ).fetchone()
    conn.close()
    if not row:
        return None
    return _flow_to_dict(row)


def get_flows_for_domain(domain: str) -> list:
    conn = _connect()
    rows = conn.execute(
        "SELECT * FROM flows WHERE domain = ? ORDER BY action",
        (domain,),
    ).fetchall()
    conn.close()
    return [_flow_to_dict(r) for r in rows]


def list_all_flows() -> list:
    conn = _connect()
    rows = conn.execute("SELECT * FROM flows ORDER BY domain, action").fetchall()
    conn.close()
    return [_flow_to_dict(r) for r in rows]


def delete_flow(domain: str, action: str) -> bool:
    conn = _connect()
    cursor = conn.execute(
        "DELETE FROM flows WHERE domain = ? AND action = ?",
        (domain, action),
    )
    conn.commit()
    conn.close()
    return cursor.rowcount > 0


def bump_flow_confidence(domain: str, action: str) -> Optional[dict]:
    """Increment confidence (max 10) and update last_verified."""
    import datetime
    conn = _connect()
    now = datetime.datetime.now().isoformat()
    conn.execute(
        "UPDATE flows SET confidence = MIN(confidence + 1, 10), last_verified = ? WHERE domain = ? AND action = ?",
        (now, domain, action),
    )
    conn.commit()
    conn.close()
    return get_flow(domain, action)


def reset_flow_confidence(domain: str, action: str, level: int = 0, failed: bool = False) -> Optional[dict]:
    """Reset confidence to a specific level. Optionally mark as failed."""
    import datetime
    conn = _connect()
    now = datetime.datetime.now().isoformat()
    if failed:
        conn.execute(
            "UPDATE flows SET confidence = ?, last_failed = ? WHERE domain = ? AND action = ?",
            (level, now, domain, action),
        )
    else:
        conn.execute(
            "UPDATE flows SET confidence = ? WHERE domain = ? AND action = ?",
            (level, domain, action),
        )
    conn.commit()
    conn.close()
    return get_flow(domain, action)


def _flow_to_dict(row) -> dict:
    d = dict(row)
    d["steps"] = json.loads(d.get("steps", "[]"))
    d["caveats"] = json.loads(d.get("caveats", "[]"))
    d["refs"] = json.loads(d.get("refs", "[]"))
    return d


# Initialize on import
init_db()
ensure_default()
