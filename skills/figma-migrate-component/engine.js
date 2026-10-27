// ==== figma-migrate-component: engine ====
// Runs inside use_figma. Expects two globals defined before this file:
//   PARAMS = { pageId, scopeIds: [], mode: 'dry' | 'apply', limit: 300, keepOld: false }
//   RECIPE = { name, sourceSets: [setName], target: { key, isSet },
//              async extract(old, H) -> { model } | { skip: reason },
//              async build(neu, model, H) }
// Guarantees: an instance is replaced only if the visible text of the new one
// matches the old one exactly; otherwise the new one is removed and the old kept.

const H = {};

H.main = async (n) => {
  const mc = await n.getMainComponentAsync();
  if (!mc) return null;
  const set = mc.parent && mc.parent.type === 'COMPONENT_SET' ? mc.parent : null;
  return { mc, set, setName: set ? set.name : mc.name, variant: set ? mc.name : '' };
};

H.isShown = (node, root) => {
  for (let n = node; n && n !== root.parent; n = n.parent) if (!n.visible) return false;
  return true;
};

// SF Symbols and other private-use glyphs are icons, not content.
H.isGlyph = (s) => [...s].every(ch => { const c = ch.codePointAt(0); return (c >= 0xE000 && c <= 0xF8FF) || c >= 0xF0000; });

H.visibleTexts = (root) => root.findAllWithCriteria({ types: ['TEXT'] })
  .filter(t => H.isShown(t, root))
  .map(t => t.characters.trim())
  .filter(s => s && !H.isGlyph(s))
  .sort();

H.overrideMap = (inst) => new Map((inst.overrides || []).map(o => [o.id, o.overriddenFields]));

H.propKey = (inst, prefix) => Object.keys(inst.componentProperties).find(k => k === prefix || k.startsWith(prefix + '#'));

H.setProps = (inst, byPrefix) => {
  const out = {};
  for (const [p, v] of Object.entries(byPrefix)) {
    const k = H.propKey(inst, p);
    if (k === undefined) throw new Error(`no property "${p}" on ${inst.name}`);
    out[k] = v;
  }
  inst.setProperties(out);
};

H.child = (root, name) => root.findOne(n => n.name === name && n.visible);
H.shownInstances = (root) => root.findAllWithCriteria({ types: ['INSTANCE'] }).filter(n => H.isShown(n, root));
H.firstText = (root) => root.findAllWithCriteria({ types: ['TEXT'] }).find(t => H.isShown(t, root));

H.loadFonts = async (t) => {
  const fonts = t.characters.length ? t.getRangeAllFontNames(0, t.characters.length) : [t.fontName];
  for (const f of fonts) await figma.loadFontAsync(f);
};

H.setText = async (t, str) => {
  if (t.characters === str) return;
  await H.loadFonts(t);
  t.characters = str;
};

// Visual overrides any layer can carry (e.g. a recoloured icon background).
const VISUAL_FIELDS = ['fills', 'strokes', 'strokeWeight', 'opacity', 'effects', 'cornerRadius'];
// Colours are often overridden as a paint/effect STYLE, not raw fills.
const STYLE_FIELDS = { fillStyleId: 'setFillStyleIdAsync', strokeStyleId: 'setStrokeStyleIdAsync', effectStyleId: 'setEffectStyleIdAsync' };
H.copyVisualOverrides = async (src, dst, ov) => {
  const f = ov.get(src.id) || [];
  for (const k of VISUAL_FIELDS)
    if (f.includes(k) && k in src && k in dst && src[k] !== figma.mixed) dst[k] = src[k];
  for (const [k, setter] of Object.entries(STYLE_FIELDS))
    if (f.includes(k) && k in src && setter in dst && src[k] !== figma.mixed) await dst[setter](src[k]);
};

// Copy only what was overridden on the source text (colour, style, font).
H.copyTextOverrides = async (src, dst, ov) => {
  const f = ov.get(src.id) || [];
  if (f.includes('fills') && src.fills !== figma.mixed) dst.fills = src.fills;
  if (f.includes('textStyleId') && src.textStyleId !== figma.mixed) { await H.loadFonts(dst); await dst.setTextStyleIdAsync(src.textStyleId); }
  if (f.includes('fontName') && src.fontName !== figma.mixed) { await figma.loadFontAsync(src.fontName); await H.loadFonts(dst); dst.fontName = src.fontName; }
};

// Make dst look like src: same component/variant, same non-variant props,
// same texts and visibility, recursively. Works for any pair of nodes with
// matching structure (e.g. Train → Train, Text → Text, icon → icon slot).
H.transplant = async (src, dst, ov) => {
  if (src.type === 'INSTANCE' && dst.type === 'INSTANCE') {
    const s = await H.main(src), d = await H.main(dst);
    if (s && d && s.mc.id !== d.mc.id) {
      if (s.set && d.set && s.set.id === d.set.id) {
        const v = {};
        for (const [k, p] of Object.entries(src.componentProperties)) if (p.type === 'VARIANT') v[k] = p.value;
        dst.setProperties(v);
      } else dst.swapComponent(s.mc);
    }
    const props = {};
    for (const [k, p] of Object.entries(src.componentProperties))
      if (p.type !== 'VARIANT' && k in dst.componentProperties && dst.componentProperties[k].value !== p.value) props[k] = p.value;
    if (Object.keys(props).length) dst.setProperties(props);
  } else if (src.type === 'TEXT' && dst.type === 'TEXT') {
    await H.setText(dst, src.characters);
    await H.copyTextOverrides(src, dst, ov);
  }
  if (src.type !== 'TEXT') await H.copyVisualOverrides(src, dst, ov);
  if (dst.visible !== src.visible) dst.visible = src.visible;
  if ('children' in src && 'children' in dst && src.type !== 'TEXT') {
    const sc = src.children, dc = dst.children;
    if (sc.length === dc.length) for (let i = 0; i < sc.length; i++) await H.transplant(sc[i], dc[i], ov);
  }
};

// Place neu exactly where old was and copy how it sits in the layout.
H.place = (old, neu) => {
  const parent = old.parent;
  // by id: node proxies inside SLOTs are not identity-equal to parent.children
  const index = parent.children.findIndex(c => c.id === old.id);
  if (index < 0) throw new Error('old node not found in its parent');
  parent.insertChild(index, neu);
  const al = 'layoutMode' in parent && parent.layoutMode !== 'NONE';
  if (al && old.layoutPositioning !== 'ABSOLUTE') {
    if (old.layoutSizingHorizontal === 'FIXED') neu.resize(old.width, neu.height);
    neu.layoutSizingHorizontal = old.layoutSizingHorizontal === 'HUG' ? 'FIXED' : old.layoutSizingHorizontal;
    neu.layoutAlign = old.layoutAlign;
    neu.layoutGrow = old.layoutGrow;
  } else {
    if (old.layoutPositioning === 'ABSOLUTE') neu.layoutPositioning = 'ABSOLUTE';
    neu.x = old.x; neu.y = old.y;
    neu.resize(old.width, neu.height);
    if ('constraints' in old) neu.constraints = old.constraints;
  }
  if (!old.visible) neu.visible = false;
  if (old.opacity !== 1) neu.opacity = old.opacity;
};

// Returns the instance that locks n (its children can't be replaced), or null.
// Slot content is editable, so a SLOT met before any INSTANCE unlocks it.
const lockingInstance = (n) => {
  for (let p = n.parent; p && p.type !== 'PAGE'; p = p.parent) {
    if (p.type === 'SLOT') return null;
    if (p.type === 'INSTANCE') return p;
  }
  return null;
};

// ---- run ----
const page = await figma.getNodeByIdAsync(PARAMS.pageId);
await figma.setCurrentPageAsync(page);
const scopes = PARAMS.scopeIds && PARAMS.scopeIds.length
  ? (await Promise.all(PARAMS.scopeIds.map(id => figma.getNodeByIdAsync(id)))).filter(Boolean)
  : [page];

const candidates = [];
const lockedIn = {};
for (const scope of scopes) {
  const list = scope.type === 'INSTANCE' ? [scope] : scope.findAllWithCriteria({ types: ['INSTANCE'] });
  for (const n of list) {
    const m = await H.main(n);
    if (!m || !RECIPE.sourceSets.includes(m.setName)) continue;
    const lock = lockingInstance(n);
    if (lock) {
      const lm = await H.main(lock);
      // a part nested inside another source instance is handled with its root
      if (lm && !RECIPE.sourceSets.includes(lm.setName)) lockedIn[lm.setName] = (lockedIn[lm.setName] || 0) + 1;
      continue;
    }
    candidates.push(n);
  }
}

const target = RECIPE.target.isSet
  ? (await figma.importComponentSetByKeyAsync(RECIPE.target.key)).defaultVariant
  : await figma.importComponentByKeyAsync(RECIPE.target.key);

const report = { recipe: RECIPE.name, mode: PARAMS.mode, found: candidates.length, lockedInLibraryComponents: lockedIn, migrated: [], wouldMigrate: 0, skipped: [], failed: [] };
const where = (n) => { const f = []; for (let p = n.parent; p && p.type !== 'PAGE'; p = p.parent) if (p.parent && (p.parent.type === 'PAGE' || p.parent.type === 'SECTION')) { f.push(p.name); break; } return f.join(''); };

const touched = new Set();
for (const old of candidates.slice(0, PARAMS.limit || 300)) {
  const label = { id: old.id, screen: where(old), texts: H.visibleTexts(old).join(' | ').slice(0, 80) };
  let ex;
  try { ex = await RECIPE.extract(old, H); } catch (e) { report.failed.push({ ...label, reason: 'extract: ' + e.message }); continue; }
  if (ex.skip) { report.skipped.push({ ...label, reason: ex.skip }); continue; }
  if (PARAMS.mode !== 'apply') { report.wouldMigrate++; continue; }

  const before = H.visibleTexts(old);
  const neu = target.createInstance();
  try {
    H.place(old, neu);
    const commit = await RECIPE.build(neu, ex.model, H);
    await H.copyVisualOverrides(old, neu, H.overrideMap(old)); // e.g. a recoloured row
    const after = H.visibleTexts(neu);
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error(`text mismatch: [${before.join(', ')}] → [${after.join(', ')}]`);
    // changes outside the new instance happen only once it is verified
    if (typeof commit === 'function') await commit();
    if (Math.abs(old.height - neu.height) > 1) (ex.model.notes = ex.model.notes || []).push(`height ${Math.round(old.height)}→${Math.round(neu.height)}`);
    touched.add(neu.parent);
    if (PARAMS.keepOld) { old.visible = false; old.name = '[migrated] ' + old.name; } else old.remove();
    report.migrated.push({ ...label, newId: neu.id, notes: ex.model.notes || [] });
  } catch (e) {
    neu.remove();
    report.failed.push({ ...label, reason: e.message });
  }
}

// Figma doesn't reflow hug-content auto-layout after children are swapped by a
// plugin (a card keeps its old height). Nudge every touched container and its
// auto-layout ancestors so they recompute.
H.reflow = (n) => {
  for (let p = n; p && p.type !== 'PAGE' && p.type !== 'SECTION'; p = p.parent)
    if ('layoutMode' in p && p.layoutMode !== 'NONE' && p.type !== 'INSTANCE') { try { const s = p.itemSpacing; p.itemSpacing = s + 1; p.itemSpacing = s; } catch (e) { /* locked layer, leave it */ } }
};
for (const p of touched) H.reflow(p);

const group = (arr) => Object.entries(arr.reduce((a, r) => (a[r.reason] = (a[r.reason] || 0) + 1, a), {})).sort((a, b) => b[1] - a[1]);
report.skippedByReason = group(report.skipped);
report.failedByReason = group(report.failed);
report.notesSummary = Object.entries(report.migrated.flatMap(r => r.notes.map(n => n.replace(/ container .*/, ' container')))
  .reduce((a, n) => (a[n] = (a[n] || 0) + 1, a), {}));
report.skipped = report.skipped.slice(0, 40);
report.migrated = report.migrated.length > 40 ? report.migrated.length : report.migrated;
return report;
