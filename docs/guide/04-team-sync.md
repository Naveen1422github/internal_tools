# 4. Team sync — how laptops share notes

## The picture

Each laptop keeps its own complete notebook and works at full speed, even offline. Sharing happens in the background:

1. You save a team-project note. Core **pings** the courier straight away.
2. The **courier** sends the change to the **post office** over HTTPS.
3. The post office gives the note its number (if new), stores it, merges it with simultaneous edits, and **rings a doorbell** on every connected laptop.
4. Other couriers collect the change and apply it to their notebook.

If anything is unreachable, the courier retries every 30 seconds. When nothing changes, nothing happens.

## Why this shape

| Choice | Why | Rejected |
|---|---|---|
| **cr-sqlite** handles the merging of rows (COLLAB-24) | a proven CRDT add-on that loads onto the existing tables; building sync ourselves is months of risk | building our own sync; Turso (primary/replica, not multiple writers) |
| A central **post office**, not peer-to-peer | one owner for numbers (no duplicate `TT-5`), one place to merge, one place to enforce permissions | each laptop numbering its own team notes |
| Save **pings** the courier (COLLAB-63/64) | instant, and costs nothing when idle | polling every 250 ms; watching the file (misses writes on Windows) |
| **Three-way text merge** (COLLAB-31) | two people editing a hub note must not silently lose each other's work | last-write-wins |
| Conflicts the merge can't solve get flagged **needs_merge**, and a person settles them on the web merge page | a machine must never guess | auto-picking a winner |
| A retried save reuses its number (COLLAB-57) | a network blip must never create a second number for the same note | — |

## What the post office actually sees

Not "Naveen superseded note 41", but **cells**: "table `entries`, row X, column `superseded_by` changed to Y". That matters for permissions (file 5): the post office has to translate cells back into actions.

## Safety rails

- **Schema guard:** a laptop and the office must be on the *same* migration (today 0012), or the office refuses (409) and the courier shows **needs-update**. That's why Rinku must update after every migration.
- **Certificate pin:** the join code contains the office's certificate fingerprint, so a laptop can't be tricked into talking to a fake office.
- **Pending notes:** if the office is down, team notes are saved and wait. Nothing is lost.
- **Solo never leaves:** solo-project notes and new `E` notes are never sent, whatever they're tagged with (rule 5 of the projects spec).

## Status

- Two-laptop test with Rinku **passed** 2026-10-10 (COLLAB-120).
- The post office runs on your laptop. A move to the company server (122.160.136.155:7443) was decided (COLLAB-113) but put on hold until development is finished (COLLAB-114).
- Known: the office still advertises your old Wi-Fi IP 192.168.0.104 (E-767).
- Not built yet: `collab join` / leave / web welcome page (stage D).
