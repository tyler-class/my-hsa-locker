# HSA Locker

Conventions for working on HSA Locker, shared with the owner's other self-hosted Cloudflare apps
(Nitrogen, Duffel, Ratio). Follow them when building or changing anything here.

## Workflow

- Start with `git pull --ff-only`.
- Every round of changes gets a new version number, without being asked: when you start making
  changes after the last push to `main`, bump the patch version in `package.json` first
  (1.0.1 → 1.0.2), so each push ships under its own version. Bump minor or major only when the
  owner asks. Mention the new version when you report or push.
- Verify with typecheck, lint, tests and `curl`; don't open a browser unless the owner asks.
- Push to `main` only when the owner says so. Deploying (`npm run deploy`) is a separate step,
  also only when asked.
- Files headed "Selfhost Kit: synced from tyler-class/selfhost-kit" (`src/*/kit/*`,
  `scripts/release.ts`, `.github/workflows/update.yml`) are overwritten by the kit's sync: make
  those changes in the kit, not here.
- Money is integer cents everywhere (`amount_cents`); show it with `money()` and read typed amounts
  with `parseTypedMoney`. Only receipts count toward totals; EOB lines never do.

## Motion

- Sheets and dialogs "lift" on every screen size: the backdrop fades in and the panel rises into
  place. Respect `prefers-reduced-motion`.
- Collapsible sections: the whole header row toggles, the chevron turns 180° (down when closed, up
  when open), the content slides open and shut, and the open state is remembered on the device.
  Use `components/Collapsible.tsx`, never a native `<details>`.
- Drag to reorder (the Insights board, `Panels.tsx`): grip handle, dashed slot where it will land,
  lifted copy under the pointer, no drop animation. On touch, start the drag after a short press so
  a swipe still scrolls. If saving the new order fails, put the old order back on screen.

## Controls

- Never a native `<select>`: use `components/Select.tsx`.
- Toggle sliders and segmented controls (`SlideToggle`, `Segmented`) draw their keyboard focus
  ring **inside** the button (an inset ring), because the track scrolls sideways and clips
  anything outside.
- Removing or changing something that can be undone (deleting an entry, discarding mail, marking
  reimbursed or not claimable) shows a toast with **Undo** instead of a `window.confirm` (`useUndo`
  in `lib/useSave.ts`; a deleted entry comes back through `POST /entries/restore`). Keep a confirm
  only where undo isn't possible: reading a document again (edits are replaced), removing a person
  (their receipts lose the link), and, for now, discarding a document (outstanding: discard
  deletes the file straight away, so it needs a delayed file delete before it can take an Undo).
- A filter shows the same choices and counts everywhere the same data appears.

## Layout and look

- No `border-top` divider on a row with rounded corners: it bends. Draw the divider as a separate
  straight line.
- Hover shades on icon buttons stay clear of dividing lines.
- Every page heading, section heading and Insights panel heading has an icon.
- Empty states: an icon in a soft circle, a headline and one line (`Empty`, `compact` inside a
  card). An Insights panel with nothing to show is hidden or says so clearly.
- Phones: text wraps rather than running off the edge (truncate only where a single line is the
  point); notes fields grow with the text (`TextArea`) instead of being a single line. Secondary
  lines sit left-aligned on their own line.
- Any grain or texture goes on backgrounds only, never over text or components, and stays subtle.

## Behaviour

- After a save, everything on screen updates straight away (`useSave` refreshes the data); nothing
  needs a reload.
- An entry can be changed the same way wherever it appears: one shared form and save hook
  (`EntryForm`, `useSave`).
- View choices (Ledger filters, collapsed sections) are remembered on the device as well as in the
  address (`lib/storage.ts` has `load`/`save` for this).

## Wording

- Product nouns are capitalized; group headings are plural ("Years", "Reimbursements").
- Say "reimbursable" and "not claimable", never the internal status names.
- Ranges of dates or times read "Jan 3 to 9", not with a dash.
- Relative times are compact, with no space: "3h ago", "5m ago", "2d ago" (`ago()`).
