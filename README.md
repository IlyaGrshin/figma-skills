# figma-skills

[Claude Code](https://claude.com/claude-code) skills for working with Figma design systems through the official [Figma MCP server](https://help.figma.com/hc/en-us/articles/32132100833559) (`use_figma`).

## Skills

### `figma-migrate-component`

Replaces instances of one component with another (e.g. a deprecated `List Item` with the new one) **without losing the content typed into them**: texts, icon swaps, toggles, badges, recoloured layers (raw fills and paint styles), backgrounds.

How it stays safe:

- **Extract → build → verify.** Content is read from the old instance into a neutral model, a fresh instance of the new component is built from it, and the visible text of both is compared. On mismatch the new instance is removed and the old one stays untouched.
- **Dry run first.** A read-only report shows what will migrate, what is skipped and why, and which instances are locked inside other library components.
- **No guessing.** Anything a recipe doesn't understand is skipped with a reason.
- Handles slot content, overrides set via styles, stale hug-content layouts after replacement, and reports visual changes (height, weight) it can't avoid.

Structure:

```
skills/figma-migrate-component/
  SKILL.md                 workflow + how to write a recipe
  engine.js                generic part: find, place, verify, roll back, report
  recipes/
    deprecated-list-item.js  example: (Deprecated) List Item → List Item
    section-slots.js         hand-built section frame → Section with Slots
```

The engine is generic; each component pair gets its own small recipe (`extract` + `build`). `recipes/deprecated-list-item.js` is a real recipe for one team library — use it as a template for yours.

## Plugin

`plugin/` is the same engine and recipe packaged as a Figma **generative plugin** ("Migrate component", id `91e527f0-d0e1-456a-9e3c-fa488879636a`): pick a recipe and a scope (selection, page, whole file), run **Check** (dry run), then **Replace**. Rows that were not migrated are listed with the reason and a jump-to-layer link; the console log and **Copy report** give a JSON report, and the last report is also saved in the file (`figma.root.getSharedPluginData('migrate_component', 'last_report')`) so an agent can read it via the Figma MCP.

The plugin source is deployed with the Figma MCP `update_generative_plugin` tool; keep `plugin/code.ts` in sync with `skills/figma-migrate-component` when a recipe changes.

## Install

Requires Claude Code with the Figma plugin (for the `figma-use` skill and the Figma MCP server).

```sh
git clone git@github.com:IlyaGrshin/figma-skills.git ~/figma-skills
ln -s ~/figma-skills/skills/figma-migrate-component ~/.claude/skills/figma-migrate-component
```

Then in Claude Code: `/figma-migrate-component` or just ask to migrate components in a Figma file. Always try it on a branch or a duplicated page first.
