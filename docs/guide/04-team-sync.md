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

## When the office refuses a change

- The office judges each laptop save as a whole. If one part isn't allowed, the whole save is refused (COLLAB-189).
- **The change is undone on your laptop.** The office writes its own value back and your laptop picks it up on the next sync.
- A refused **new** note is different: it stays only on your laptop and never reaches the team.
- The courier shows: `N change(s) refused by the post office: collab refused list`. Nothing you typed is lost silently (file 7 has the commands).

## Safety rails

- **Schema guard:** a laptop and the office must be on the *same* migration (today 0013), or the office refuses (409) and the courier shows **needs-update**. That's why Rinku must update after every migration.
- **Certificate pin:** the join code contains the office's certificate fingerprint, so a laptop can't be tricked into talking to a fake office.
- **Pending notes:** if the office is down, team notes are saved and wait. Nothing is lost.
- **Private stays private:** notes in a private project are never sent, whatever they're tagged with.

## Status

- Two-laptop test with Rinku **passed** 2026-10-10 (COLLAB-120).
- **2026-10-23: the post office moved off your laptop** to a free Oracle Cloud VM at `https://168.138.114.191:7443` (COLLAB-203), so the first teammate (Gaurav) can reach it from any network.
  - It runs as a Linux service that restarts itself and starts at boot.
  - It kept its certificate, so your laptop only ran `collab sync set-address`.
  - The old laptop office was renamed `post-office.MOVED-TO-ORACLE-2026-10-23` and must never run again: two offices would hand out the same numbers.
  - Moving it again (e.g. to the company server, COLLAB-113): `bundle` on the stopped office, copy it over, then `set-address` on each laptop (post-office/DEPLOY.md).
- Sharing is by project now: a note reaches only the members of its project. E is the emp1st project and has its own members. The switch from shared modules to E is a one-time runbook in file 7 (section 10).
- First real use found a bug: one old summary note (E-261) made the office refuse the whole upload (COLLAB-205). It was fixed the same day.
- Not built yet: `collab join` / leave / web welcome page (stage D).
