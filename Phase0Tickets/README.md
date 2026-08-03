# Phase 0 ticket workflow

`open/` is the complete planned Phase 0 backlog. Planned work begins there.

1. Before implementation starts, move exactly one ticket from `open/` to `inProgress/`. A single implementation agent should normally have no more than one ticket in progress.
2. Keep the ticket ID and filename unchanged when moving it between lifecycle directories.
3. Implement only the ticket's stated scope. Scope discovered during implementation must not silently expand the active ticket.
4. Move a ticket to `done/` only after every acceptance criterion and test requirement passes and its completion record is filled in.
5. Failed or blocked work remains in `inProgress/`, with the blocker recorded, rather than being marked done.

Newly discovered necessary Phase 0 work requires a new ticket, explicit justification, an update to `PHASE_0_COVERAGE.md`, and review of why the original backlog was incomplete. Optional polish must not become required work without review. Phase 1 and later ideas belong outside this backlog.

`P0-015` is the final Phase 0 verification ticket. It may begin only after every earlier ticket is in `done/`.
