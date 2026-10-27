// ==== figma-migrate-component: engine ====
// Runs inside use_figma. Expects two globals defined before this file:
//   PARAMS = { pageId, scopeIds: [], mode: 'dry' | 'apply', limit: 300, keepOld: false }
//   RECIPE = { name, sourceSets: [setName], target: { key, isSet },
//              async extract(old, H) -> { model } | { skip: reason },
//              async build(neu, model, H),
//              optional: findSources(scope, H), textFilter(node, root), async verify(old, neu, model, H) }
// Guarantees: an instance is replaced only if the visible text of the new one
// matches the old one exactly; otherwise the new one is removed and the old kept.
// textFilter(node, root) prunes subtrees the plugin API can't read on the new
// side (e.g. slot content); verify must then cover them another way.

const H = {};

H.main = async (n) => {
  const mc = await n.getMainComponentAsync();
  if (!mc) return null;
  const set = mc.parent && mc.parent.type === 'COMPONENT_SET' ? mc.parent : null;
  return { mc, set, setName: set ? set.name : mc.name, variant: set ? mc.name : '' };
};

// The root's own visibility doesn't count: hidden rows are migrated too (and stay hidden).
// Compare ids: `parent` may return a different object for the same layer.
H.isShown = (node, root) => {
  for (let n = node; n && n.id !== root.id; n = n.parent) if (!n.visible) return false;
  return true;
};

// SF Symbols and other private-use glyphs are icons, not content.
H.isGlyph = (s) => [...s].every(ch => { const c = ch.codePointAt(0); return (c >= 0xE000 && c <= 0xF8FF) || c >= 0xF0000; });

// keep(node, root) === false prunes the node and its subtree. Pruning matters:
// walking into slot content can throw ("node … does not exist").
H.texts = (root, keep) => {
  if (!keep) return root.findAllWithCriteria({ types: ['TEXT'] });
  const out = [];
  const walk = (n) => { for (const c of n.children) if (keep(c, root)) c.type === 'TEXT' ? out.push(c) : 'children' in c && walk(c); };
  walk(root);
  return out;
};

H.visibleTexts = (root, keep) => H.texts(root, keep)
  .filter(t => H.isShown(t, root))
  .map(t => t.characters.trim())
  .filter(s => s && !H.isGlyph(s))
  .sort();

// Texts coloured in parts, as "characters → colour per range". Comparing only
// characters misses a multi-colour text that collapsed to one colour.
H.multiColourTexts = (root, keep) => {
  const out = {};
  for (const t of H.texts(root, keep)) {
    if (!H.isShown(t, root) || t.fills !== figma.mixed) continue;
    out[t.characters.trim()] = JSON.stringify(t.getStyledTextSegments(['fills']).map(s => [s.start, s.end, s.fills.map(p => p.type === 'SOLID' ? [p.color, p.opacity] : p.type)]));
  }
  return out;
};

// Only instances have overrides (on a frame the getter throws).
H.overrideMap = (inst) => new Map((inst.type === 'INSTANCE' ? inst.overrides : []).map(o => [o.id, o.overriddenFields]));

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
// A text coloured in parts ("$12.53B" black + "↑ 0.88%" green) has mixed
// fills: copy it range by range, otherwise the parts collapse to one colour.
H.copyTextOverrides = async (src, dst, ov) => {
  const mixed = src.fills === figma.mixed || src.fontName === figma.mixed || src.textStyleId === figma.mixed;
  if (mixed && src.characters === dst.characters) {
    const segs = src.getStyledTextSegments(['fills', 'fillStyleId', 'fontName', 'textStyleId']);
    await H.loadFonts(dst);
    for (const s of segs) await figma.loadFontAsync(s.fontName);
    for (const s of segs) {
      if (src.textStyleId === figma.mixed && s.textStyleId) await dst.setRangeTextStyleIdAsync(s.start, s.end, s.textStyleId);
      if (src.fontName === figma.mixed) dst.setRangeFontName(s.start, s.end, s.fontName);
      if (s.fillStyleId) await dst.setRangeFillStyleIdAsync(s.start, s.end, s.fillStyleId);
      else dst.setRangeFills(s.start, s.end, s.fills);
    }
    return;
  }
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
  // a resized icon (e.g. 28 → 24) keeps its size
  const sz = ov.get(src.id) || [];
  if ((sz.includes('width') || sz.includes('height')) && src.type === 'INSTANCE' && 'resize' in dst) dst.resize(src.width, src.height);
  if (dst.visible !== src.visible) dst.visible = src.visible;
  if ('children' in src && 'children' in dst && src.type !== 'TEXT') {
    const sc = src.children, dc = dst.children;
    if (sc.length === dc.length) for (let i = 0; i < sc.length; i++) await H.transplant(sc[i], dc[i], ov);
    else {
      // Structure differs (e.g. src comes from an outdated library version):
      // pair children by name, then the rest by kind (same component set /
      // both texts) in order, and hide what src doesn't have.
      const used = new Set(), rest = [];
      for (const d of dc) {
        const s = sc.find(x => x.name === d.name && !used.has(x.id));
        if (s) { used.add(s.id); await H.transplant(s, d, ov); } else rest.push(d);
      }
      const kind = async (n) => n.type === 'INSTANCE' ? 'I:' + ((await H.main(n)) || {}).setName : n.type;
      for (const d of rest) {
        const dk = await kind(d);
        let s = null;
        for (const x of sc) if (!used.has(x.id) && x.visible && await kind(x) === dk) { s = x; break; }
        if (s) { used.add(s.id); await H.transplant(s, d, ov); }
        else if (d.visible) d.visible = false;
      }
    }
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
// use_figma may default to skipping hidden layers inside instances; building
// and verifying rely on full child lists (hidden rows, hidden parts).
figma.skipInvisibleInstanceChildren = false;
const page = await figma.getNodeByIdAsync(PARAMS.pageId);
await figma.setCurrentPageAsync(page);
const scopes = PARAMS.scopeIds && PARAMS.scopeIds.length
  ? (await Promise.all(PARAMS.scopeIds.map(id => figma.getNodeByIdAsync(id)))).filter(Boolean)
  : [page];

const candidates = [];
const lockedIn = {};
let otherLibrary = 0;
for (const scope of scopes) {
  // A recipe whose source is not an instance (e.g. a hand-built frame) finds its own sources.
  if (RECIPE.findSources) {
    for (const n of await RECIPE.findSources(scope, H)) if (!lockingInstance(n)) candidates.push(n);
    continue;
  }
  const list = scope.type === 'INSTANCE' ? [scope] : scope.findAllWithCriteria({ types: ['INSTANCE'] });
  for (const n of list) {
    const m = await H.main(n);
    if (!m || !RECIPE.sourceSets.includes(m.setName)) continue;
    // same name from another library (e.g. Android) is not ours
    if (RECIPE.sourceKeys && !RECIPE.sourceKeys.includes((m.set || m.mc).key)) { otherLibrary++; continue; }
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

const report = { recipe: RECIPE.name, mode: PARAMS.mode, found: candidates.length, otherLibrary, lockedInLibraryComponents: lockedIn, migrated: [], wouldMigrate: 0, skipped: [], failed: [] };
// the screen = top-level frame on the page or inside a section
const screenOf = (n) => { for (let p = n.parent; p && p.type !== 'PAGE'; p = p.parent) if (p.parent && (p.parent.type === 'PAGE' || p.parent.type === 'SECTION')) return p; return null; };
const where = (n) => { const s = screenOf(n); return s ? s.name : ''; };

const touched = new Set();
for (const old of candidates.slice(0, PARAMS.limit || 300)) {
  const label = { id: old.id, screen: where(old), texts: H.visibleTexts(old).join(' | ').slice(0, 80) };
  const guard = RECIPE.guardScreen && RECIPE.guardScreen(screenOf(old));
  if (guard) { report.skipped.push({ ...label, reason: guard }); continue; }
  let ex;
  try { ex = await RECIPE.extract(old, H); } catch (e) { report.failed.push({ ...label, reason: 'extract: ' + e.message }); continue; }
  if (ex.skip) { report.skipped.push({ ...label, reason: ex.skip }); continue; }
  if (PARAMS.mode !== 'apply') { report.wouldMigrate++; continue; }

  const keep = RECIPE.textFilter;
  const before = H.visibleTexts(old, keep);
  const beforeColours = H.multiColourTexts(old, keep);
  const neu = target.createInstance();
  try {
    H.place(old, neu);
    const commit = await RECIPE.build(neu, ex.model, H);
    await H.copyVisualOverrides(old, neu, H.overrideMap(old)); // e.g. a recoloured row
    const after = H.visibleTexts(neu, keep);
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error(`text mismatch: [${before.join(', ')}] → [${after.join(', ')}]`);
    const afterColours = H.multiColourTexts(neu, keep);
    for (const [txt, sig] of Object.entries(beforeColours))
      if (afterColours[txt] !== sig) throw new Error(`multi-colour text lost its colours: "${txt}"`);
    if (RECIPE.verify) await RECIPE.verify(old, neu, ex.model, H);
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
