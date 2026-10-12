# PR stamp files

Each merged PR adds exactly one new file in this directory holding its one-line
stamp. No PR edits a line another PR wrote, so stamps never conflict.

- Name: `<issue>-<slug>.md` (for example `1433-stamp-files.md`); a PR without
  an issue uses `pr<number>-<slug>.md`.
- Content: one line, the same stamp format the ledger used — issue (and epic),
  branch, date, base SHA, PR, then what landed and where its receipt lives.
- Newest first: `git log --diff-filter=A --format=%h -- docs/agents-stamps/`.

`docs/agents-stamps.md` is the frozen ledger of every stamp before #1433. It
takes no new lines.
