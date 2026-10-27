---
name: figma-migrate-component
description: Replace instances of one Figma component with another (e.g. a deprecated List Item with the new one) without losing the content typed into them — texts, icons, toggles, colour overrides. Each replacement is verified by comparing visible text before/after and rolled back on mismatch. Use when the user wants to migrate, swap, replace or upgrade components in Figma mockups, get rid of deprecated components, or move screens to a new library version.
---

# Migrate Figma components without losing content

A plain `swapComponent` loses overrides whenever the two components have
different layer structures. This skill rebuilds each instance instead:
**extract** the content from the old instance into a neutral model, **build**
a fresh instance of the new component from that model, **verify** that the
visible text is identical, and only then remove the old one.

Files:
- `engine.js` — generic part: finds instances, places the new one where the
  old was (same parent, index, auto-layout sizing), verifies, rolls back,
  reports. Never edit it for a specific migration.
- `recipes/<name>.js` — one per component pair: `extract(old)` → model,
  `build(new, model)`. Available recipes:
  - `deprecated-list-item` — `(Deprecated) List Item` → `List Item`
    (library 2 · UI · iOS).

Load `figma:figma-use` first (mandatory before `use_figma`).

## Running a migration

1. `create_session` for the file. Get page ids with `get_metadata` (no nodeId).
2. Assemble the script: `const PARAMS = {...};` + contents of the recipe +
   contents of `engine.js`, in that order, as one `use_figma` code string.
   Read both files fresh each time — don't paste from memory.
   ```js
   const PARAMS = {
     pageId: '491:8393',      // one page per call; fan out pages in parallel
     scopeIds: [],            // optional frame/section ids; empty = whole page
     mode: 'dry',             // 'dry' = read-only report, 'apply' = replace
     limit: 300,              // max instances per call
     keepOld: false,          // true = hide old as "[migrated] …" instead of deleting
   };
   ```
3. **Always run `mode: 'dry'` first** and show the user the report:
   how many will migrate, skipped grouped by reason, and
   `lockedInLibraryComponents` (rows baked into other library components —
   those must be fixed in the library, not in the mockup).
4. Before `apply`, confirm with the user and suggest working in a Figma
   branch or a duplicate of the file. Undo history also works, but a branch
   lets the team review the result.
5. `apply` on one screen first (`scopeIds: [frameId]`), screenshot that frame
   with `get_screenshot`, compare with a screenshot taken before. Then run
   the rest of the page.
6. Report to the user: migrated / skipped / failed counts, failed reasons
   (each failed one was rolled back — old instance untouched), and `notes`
   (things that changed visually but not in content, e.g. "title was medium
   weight").

## What the engine guarantees

- Visible text (excluding SF Symbol glyphs) of the new instance must equal
  the old one as a multiset, otherwise the new instance is deleted and the
  old one stays. So text content is never silently lost.
- Instances inside other instances are not touched (they can't be edited),
  except inside a `SLOT`, whose content is editable.
- Colour / text-style / font overrides are copied only if they were actually
  overridden on the old instance (`instance.overrides`), so the new
  component's tokens are not clobbered with stale hard-coded values.
- Anything the recipe does not understand is **skipped with a reason**,
  never guessed. Unknown cases show up in `skippedByReason`.

## Writing a recipe for a new pair

1. Inspect both components read-only: dump an old instance tree (names,
   types, visible texts, nested main components + their component set names,
   `componentProperties`) and the new component set's
   `componentPropertyDefinitions` and variant children trees.
2. Find the shared atoms. If both sides build text out of the same
   components (here: `Text`, `Train`), `H.transplant(src, dst, ov)` copies
   them wholesale — variant, props, texts, nested swaps.
3. Write `recipes/<name>.js` defining `const RECIPE = { name, sourceSets,
   target: { key, isSet }, extract, build }`:
   - `sourceSets` — component (set) names whose instances are migrated.
   - `sourceKeys` (optional) — keys of the source sets. Use them when another
     library (e.g. Android) has components with the same names.
   - `guardScreen(screen)` (optional) — return a reason to skip a whole
     screen, e.g. Android mockups (360px wide) for an iOS recipe.
   - `target.key` — published key of the new component (or set; `isSet:
     true` uses its default variant).
   - `extract(old, H)` returns `{ model }` or `{ skip: 'reason' }`. Keep
     node references in the model; put human notes in `model.notes`.
   - `build(neu, model, H)` configures the already-placed new instance.
     Anything that touches nodes outside it (container fills etc.) goes into
     a function `build` returns — the engine calls it only after the text
     check passed, so a rollback never leaves stray changes behind.
   - Locate parts by component set name (`H.main(n).setName`), never by
     layer name: layer names in mockups are often renamed copies and differ
     from the library ("Left" vs "List Item / Left").
   - A part can be "on" but render nothing (its icon hidden by an override).
     Check for visible leaves, not just the part's own visibility.
   - Check what the old component painted itself (backgrounds, separators,
     radius) that the new one expects from its container — text verification
     won't catch a lost background, only a screenshot will.
4. Dry-run on a real page, iterate until `skippedByReason` contains only
   cases that genuinely have no counterpart, then test `apply` on one frame.

Helpers available in recipes (`H.*`): `main(n)` → `{mc, set, setName,
variant}`, `isShown(n, root)`, `shownInstances(root)`, `firstText(root)`,
`child(root, name)`, `propKey(inst, 'Show Left')`, `setProps(inst, {'Show
Left': true, Type: 'Coin'})` (by property name without `#id`),
`setText(t, str)` (loads fonts), `copyTextOverrides(src, dst, ov)`,
`transplant(src, dst, ov)`, `overrideMap(inst)`, `visibleTexts(root)`.
