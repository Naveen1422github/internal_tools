# Collab — Owner's Guide

**This guide is for you, Naveen.** It explains in plain words what collab is, what has been built, and *why* each big choice was made, so you keep a real understanding of your own system even though the AI writes the code.

- **Who updates it:** Claude, whenever a piece of collab ships or a big decision changes.
- **Who reads it:** you. Claude does not use this guide to make decisions. Collab notes (the `COLLAB-…` entries) stay the working record. Where this guide and collab disagree, collab wins, and the guide is out of date.
- **References:** `COLLAB-123` is a note in your collab notebook. Ask Claude "show me COLLAB-123" to read the full note behind any line here.

Last updated: **2026-10-26** (sharing is by project; the E switch runbook in file 7).

## Read in this order

| # | File | What it answers |
|---|---|---|
| 1 | [What collab is](01-what-collab-is.md) | What problem it solves, its parts, where things live |
| 2 | [Timeline](02-timeline.md) | What was built when, June → today |
| 3 | [Notes, numbers, projects](03-notes-numbers-projects.md) | How a note is stored, numbered, grouped, copied |
| 4 | [Team sync](04-team-sync.md) | How two laptops share notes: courier + post office |
| 5 | [Roles & permissions (RnR)](05-roles-and-permissions.md) | Who may do what, and how the AI is limited |
| 6 | [Decision log](06-decision-log.md) | Every big decision: what, why, what was rejected |
| 7 | [Running it](07-running-it.md) | **Do-it-yourself runbook:** people, sharing, onboarding, the VM, backups + restore, upgrades, troubleshooting |
| 8 | [Open items](08-open-items.md) | What's not done yet, what's parked, what's next |

## How to learn your own system from this

1. Read file 1 and file 2 once, end to end.
2. For any area you want to understand deeply, read its file, then ask Claude to walk you through the code it names ("show me how the post office filters deliveries").
3. When something surprises you, check the decision log (file 6) before assuming it's a bug. It may have been a deliberate trade-off.

## Change history of this guide

- 2026-10-18: first version, covering June → RnR S1.
