// Migrate component — generative plugin version of the figma-migrate-component
// skill (same engine and recipe as skills/figma-migrate-component).
// Replaces deprecated instances with a new component without losing content:
// extract → build → verify (texts + multi-colour texts) → roll back on mismatch.

// The engine walks layers of many node types generically (instances, texts,
// frames, slots), so it uses one loose type instead of per-type unions.
type Loose = ReturnType<typeof JSON.parse>

const VERSION = '1.2.0'
const PANEL_WIDTH = 360
const DATA_NS = 'migrate_component' // shared plugin data namespace for the last report
const REPORT_KEY = 'last_report'
const MAX_REPORT_CHARS = 90000
const CHECK_TTL_MS = 15 * 60 * 1000 // Replace reuses a check this fresh instead of searching again

// ===================================================================== recipes

const LEFT: Record<string, string> = { 'Avatar': 'Avatar', 'Product Icon': 'Coin', 'Transaction Icon': 'Circle Icon', 'Icon Square': 'Icon Square', 'Placeholder': 'Placeholder', 'Icon': 'Icon' }
const BODY_TYPE: Record<string, string> = { 'Regular': 'Regular', 'Accent': 'Accent', 'Destructive': 'Destructive', 'Text Placeholder': 'Placeholder' }

// (Deprecated) List Item → List Item, library 2 · UI · iOS.
const LIST_ITEM: Loose = {
  id: 'deprecated-list-item',
  name: '(Deprecated) List Item → List Item (iOS)',
  sourceSets: ['(Deprecated) List Item', '(Deprecated) List Item / Body'],
  // The Android library reuses the same names, so names alone are not enough.
  sourceKeys: ['d4037f9d28891cc8f824217ffbcff8b4ab2bd4f4', '5ee5ecb2cefb3283024a88e3534058d929cbe24f'],
  target: { key: '308e3f5810c2de64b57ee01fd1c5df259841fce2', isSet: false },
  // iOS screens are 375–440 wide; Android mockups are 360.
  guardScreen: (screen: Loose) => screen && screen.width <= 360 ? 'android screen (360px) — not an iOS recipe' : null,

  async extract(old: Loose, H: Loose) {
    const ov = H.overrideMap(old)
    const notes: string[] = []
    const text = (root: Loose, name: string) => root.findAllWithCriteria({ types: ['TEXT'] }).find((t: Loose) => t.name === name && H.isShown(t, root))
    const inst = async (root: Loose, setName: string) => { for (const n of H.shownInstances(root)) { const m = await H.main(n); if (m && m.setName === setName) return n } }

    let container: Loose = (await H.main(old)).setName === '(Deprecated) List Item / Body' ? old : null
    let left: Loose, body: Loose, right: Loose
    for (const n of H.shownInstances(old)) {
      const m = await H.main(n); if (!m) continue
      const s = m.setName.replace(/^\(Deprecated\)\s+/, '')
      const p: Loose = {}
      for (const [k, v] of Object.entries<Loose>(n.componentProperties)) p[k.split('#')[0]] = v.value
      if (s === 'List Item / Body') container = container || n
      else if (s.startsWith('List Item / Left / ') && !left) left = { n, kind: s.slice(19), p }
      else if (s.startsWith('List Item / Body / ') && !body) body = { n, kind: s.slice(19), p }
      else if (s.startsWith('List Item / Right / ') && !right) right = { n, kind: s.slice(20), p }
    }
    if (!container) return { skip: old.children.length ? 'no container' : 'empty row (no content) — spacer?' }
    const cp: Loose = {}
    for (const [k, v] of Object.entries<Loose>(container.componentProperties)) cp[k.split('#')[0]] = v.value
    if (cp['Left Controls']) return { skip: 'left controls — no mapping yet' }
    if (!body) return { skip: 'no body' }

    const model: Loose = { ov, notes, separator: !!cp['Separator'] }
    if (container.fills !== figma.mixed) {
      const bg = container.fills.filter((f: Loose) => f.visible !== false)
      if (bg.length) model.bg = bg
    }

    if (left) {
      if (left.kind === 'Search Field') return { skip: 'search field row → use Text Field (Search) instead' }
      if (!LEFT[left.kind]) return { skip: 'left: ' + left.kind }
      if (left.p['Show Badge']) return { skip: 'left: icon badge has no counterpart' }
      // Some Left variants wrap the icon in a Container frame.
      const icon = H.shownInstances(left.n)[0]
      if (!icon) return { skip: 'left: no icon' }
      model.left = { type: LEFT[left.kind], icon }
    }

    const b: Loose = { badge: null }
    if (body.kind === '1 Line') {
      if (body.p.Dropdown === 'True' || body.p.Counter === 'True') return { skip: 'body: inline dropdown/counter — no counterpart in List Item (library gap)' }
      if (!BODY_TYPE[body.p.Type]) return { skip: 'body type: ' + body.p.Type }
      b.type = BODY_TYPE[body.p.Type]
      b.title = { kind: 'text', node: text(body.n, 'Label') }
    } else if (body.kind === '2 Line') {
      if (body.p.Action === 'True') return { skip: 'body: action link under title — no counterpart in List Item (library gap)' }
      if (body.p.Compact === 'True') notes.push('was compact')
      if (/Medium/.test(body.p.Type)) notes.push('title was medium weight')
      b.type = 'Regular'
      b.title = { kind: 'text', node: text(body.n, 'Label') }
      const sub = body.n.findAllWithCriteria({ types: ['TEXT'] }).find((t: Loose) => t.name === 'Subtitle' && H.isShown(t, body.n) && t.parent.name !== 'Badge')
      if (sub) b.subtitle = { kind: 'text', node: sub }
    } else if (body.kind === '2 Line · Train') {
      b.type = 'Regular'
      const area = body.n.findOne((n: Loose) => n.name === 'Label Area')
      const t = area && await inst(area, 'Text')
      if (!t) return { skip: 'body: no title' }
      b.title = { kind: 'inst', node: t }
      const tr = await inst(body.n, 'Train')
      if (tr) b.subtitle = { kind: 'train', node: tr }
    } else return { skip: 'body: ' + body.kind }
    if (!b.title.node) return { skip: 'body: no title' }
    const badge = await inst(body.n, 'Badge')
    if (badge) b.badge = badge
    b.lines = b.subtitle ? '2 Line ↑' : '1 Line'
    if (b.lines !== '1 Line' && b.type !== 'Regular') return { skip: 'body: ' + b.type + ' with 2 lines' }
    model.body = b

    // A right part whose content is hidden by an override renders nothing.
    const rendersSomething = (n: Loose) => n.findAll((x: Loose) => !('children' in x)).some((x: Loose) => H.isShown(x, n))
    if (right && !rendersSomething(right.n)) { notes.push('empty right part dropped'); right = null }
    if (right) {
      const k = right.kind, r: Loose = {}
      const label = () => ({ kind: 'text', node: text(right.n, 'Label') })
      if (k === 'Input Label') return { skip: 'right: Input Label is a form field → use Text Field' }
      if (k === 'Chevron') Object.assign(r, { lines: '1 Line', type: 'Chevron' })
      else if (k === 'Label') Object.assign(r, { lines: '1 Line', type: 'Label', title: label() })
      else if (k === 'Label + Chevron') Object.assign(r, { lines: '1 Line', type: 'Label + Chevron', title: label() })
      else if (k === 'Transaction / Subtitle + Label') Object.assign(r, { lines: '2 Line ↑', type: 'Regular', title: label(), subtitle: { kind: 'text', node: text(right.n, 'Subtitle') } })
      else if (k === 'Transaction / Subtitle + Train') Object.assign(r, { lines: '2 Line ↑', type: 'Regular', title: label(), subtitle: { kind: 'train', node: await inst(right.n, 'Train') } })
      else if (k === 'Transaction / Subtitle + Label + Icon') Object.assign(r, { lines: '2 Line ↑', type: 'Regular + Icon', title: label(), subtitle: { kind: 'text', node: text(right.n, 'Subtitle') }, icon: right.n.children.find((c: Loose) => c.type === 'INSTANCE' && c.visible) })
      else if (k === 'Checkmark') Object.assign(r, { lines: '1 Line', type: 'Checkmark' })
      else if (k === 'Clear') Object.assign(r, { lines: '1 Line', type: 'Clear' })
      else if (k === 'Switch') Object.assign(r, { lines: '1 Line', type: 'Switch', control: await inst(right.n, 'Switch') })
      else if (k === 'Button') Object.assign(r, { lines: '1 Line', type: 'Button', control: await inst(right.n, 'Button') })
      else return { skip: 'right: ' + k }
      if ((r.title && !r.title.node) || (r.subtitle && !r.subtitle.node)) {
        if (r.title && !r.title.node) return { skip: 'right: ' + k + ' without label' }
        if (r.lines === '2 Line ↑') Object.assign(r, { lines: '1 Line', type: 'Label', subtitle: undefined })
      }
      model.right = r
    }
    return { model }
  },

  async build(neu: Loose, m: Loose, H: Loose) {
    H.setProps(neu, { 'Show Left': !!m.left, 'Show Right': !!m.right, 'Show Separator': m.separator, 'Show Left Control': false })
    // Parts are found by component set, not layer name (mockups rename layers).
    const part = async (setName: string) => {
      for (const n of neu.findAllWithCriteria({ types: ['INSTANCE'] })) { const mm = await H.main(n); if (mm && mm.setName === setName) return n }
      throw new Error('no part ' + setName)
    }
    // keepCount: Badge=True puts the badge into Title's Train as a 2nd item.
    const fill = async (root: Loose, slotName: string, seg: Loose, keepCount: boolean) => {
      const slot = root.findOne((n: Loose) => n.type === 'INSTANCE' && n.name === slotName)
      if (!slot) throw new Error('no slot ' + slotName)
      if (seg.kind === 'train') return H.transplant(seg.node, slot, m.ov)
      if (!keepCount && slot.componentProperties.Count && slot.componentProperties.Count.value !== '1') slot.setProperties({ Count: '1' })
      const label = slot.children.find((c: Loose) => c.type === 'INSTANCE')
      if (seg.kind === 'inst') return H.transplant(seg.node, label, m.ov)
      const t = H.firstText(label)
      await H.setText(t, seg.node.characters)
      await H.copyTextOverrides(seg.node, t, m.ov)
    }

    if (m.left) {
      const L = await part('List Item / Left')
      H.setProps(L, { Type: m.left.type })
      await H.transplant(m.left.icon, L.children.find((c: Loose) => c.type === 'INSTANCE'), m.ov)
    }
    const B = await part('List Item / Body')
    H.setProps(B, { Lines: m.body.lines, Type: m.body.type, Badge: m.body.badge ? 'True' : 'False' })
    await fill(B, 'Title', m.body.title, !!m.body.badge)
    if (m.body.subtitle) await fill(B, 'Subtitle', m.body.subtitle, false)
    if (m.body.badge) {
      let nb: Loose
      for (const n of H.shownInstances(B)) { const mm = await H.main(n); if (mm && mm.setName === 'Badge') { nb = n; break } }
      if (!nb) throw new Error('new body has no Badge')
      await H.transplant(m.body.badge, nb, m.ov)
    }
    if (m.right) {
      const R = await part('List Item / Right')
      H.setProps(R, { Lines: m.right.lines, Type: m.right.type })
      if (m.right.title) await fill(R, 'Title', m.right.title, false)
      if (m.right.subtitle) await fill(R, 'Subtitle', m.right.subtitle, false)
      if (m.right.control) {
        const slot = R.findOne((n: Loose) => n.type === 'INSTANCE' && n.name === m.right.type)
        if (!slot) throw new Error('no ' + m.right.type + ' in new Right')
        await H.transplant(m.right.control, slot, m.ov)
      }
      if (m.right.icon) await H.transplant(m.right.icon, R.findOne((n: Loose) => n.type === 'INSTANCE' && n.name === 'Icon'), m.ov)
    }
    // Library gap: Root hugs its body; stretch it so text centres and the separator sits at the bottom.
    const root = neu.findOne((n: Loose) => n.type === 'FRAME' && n.name === 'Root')
    if (root && root.height < neu.height) { root.layoutSizingVertical = 'FILL'; m.notes.push('Root stretched to row height') }

    // Runs only after verification passed (touches the container).
    return () => {
      if (!m.bg) return
      const p = neu.parent
      const hasFill = (n: Loose) => 'fills' in n && n.fills !== figma.mixed && n.fills.some((f: Loose) => f.visible !== false)
      if (hasFill(p)) return
      if (p.type === 'FRAME' && p.clipsContent && p.cornerRadius !== 0) { p.fills = m.bg; m.notes.push('background moved to container') }
      else { neu.fills = m.bg; m.notes.push('background kept on row') }
    }
  },
}

const RECIPES: Loose[] = [LIST_ITEM]

// ====================================================================== engine

const H: Loose = {}
const mainOf = async (n: Loose) => {
  const mc = await n.getMainComponentAsync()
  if (!mc) return null
  const set = mc.parent && mc.parent.type === 'COMPONENT_SET' ? mc.parent : null
  return { mc, set, setName: set ? set.name : mc.name }
}
// Old layers never change, so their lookups are cached. Layers of the instance
// being built keep their ids while variants change: never cache those
// (its descendants' ids are 'I<id>;…').
const mainCache = new Map<string, Loose>()
let buildingId = ''
const mainCached = async (n: Loose) => {
  if (!mainCache.has(n.id)) mainCache.set(n.id, await mainOf(n))
  return mainCache.get(n.id)
}
H.main = (n: Loose) => buildingId && (n.id === buildingId || n.id.startsWith('I' + buildingId + ';')) ? mainOf(n) : mainCached(n)
// The root's own visibility doesn't count: hidden rows are migrated too (and stay hidden).
// Compare ids: `parent` may return a different object for the same layer.
H.isShown = (node: Loose, root: Loose) => { for (let n: Loose = node; n && n.id !== root.id; n = n.parent) if (!n.visible) return false; return true }
H.isGlyph = (s: string) => [...s].every((ch: string) => { const c = ch.codePointAt(0) || 0; return (c >= 0xE000 && c <= 0xF8FF) || c >= 0xF0000 })
H.visibleTexts = (root: Loose) => root.findAllWithCriteria({ types: ['TEXT'] }).filter((t: Loose) => H.isShown(t, root)).map((t: Loose) => t.characters.trim()).filter((s: Loose) => s && !H.isGlyph(s)).sort()
// Texts coloured in parts ("$12.53B" black + "↑ 0.88%" green).
H.multiColourTexts = (root: Loose) => {
  const out: Record<string, string> = {}
  for (const t of root.findAllWithCriteria({ types: ['TEXT'] })) {
    if (!H.isShown(t, root) || t.fills !== figma.mixed) continue
    out[t.characters.trim()] = JSON.stringify(t.getStyledTextSegments(['fills']).map((s: Loose) => [s.start, s.end, s.fills.map((p: Loose) => p.type === 'SOLID' ? [p.color, p.opacity] : p.type)]))
  }
  return out
}
H.overrideMap = (inst: Loose) => new Map<string, string[]>((inst.overrides || []).map((o: Loose) => [o.id, o.overriddenFields]))
H.propKey = (inst: Loose, prefix: string) => Object.keys(inst.componentProperties).find((k: Loose) => k === prefix || k.startsWith(prefix + '#'))
H.setProps = (inst: Loose, byPrefix: Loose) => {
  const out: Loose = {}
  for (const [p, v] of Object.entries(byPrefix)) {
    const k = H.propKey(inst, p)
    if (k === undefined) throw new Error('no property "' + p + '" on ' + inst.name)
    out[k] = v
  }
  inst.setProperties(out)
}
H.shownInstances = (root: Loose) => root.findAllWithCriteria({ types: ['INSTANCE'] }).filter((n: Loose) => H.isShown(n, root))
H.firstText = (root: Loose) => root.findAllWithCriteria({ types: ['TEXT'] }).find((t: Loose) => H.isShown(t, root))
const loadedFonts = new Set<string>()
H.loadFont = async (f: Loose) => {
  const k = f.family + '|' + f.style
  if (loadedFonts.has(k)) return
  await figma.loadFontAsync(f)
  loadedFonts.add(k)
}
H.loadFonts = async (t: Loose) => {
  const fonts = t.characters.length ? t.getRangeAllFontNames(0, t.characters.length) : [t.fontName]
  for (const f of fonts) await H.loadFont(f)
}
H.setText = async (t: Loose, str: string) => { if (t.characters === str) return; await H.loadFonts(t); t.characters = str }

const VISUAL_FIELDS = ['fills', 'strokes', 'strokeWeight', 'opacity', 'effects', 'cornerRadius']
const STYLE_FIELDS: Record<string, string> = { fillStyleId: 'setFillStyleIdAsync', strokeStyleId: 'setStrokeStyleIdAsync', effectStyleId: 'setEffectStyleIdAsync' }
H.copyVisualOverrides = async (src: Loose, dst: Loose, ov: Loose) => {
  const f = ov.get(src.id) || []
  for (const k of VISUAL_FIELDS) if (f.includes(k) && k in src && k in dst && src[k] !== figma.mixed) dst[k] = src[k]
  for (const [k, setter] of Object.entries(STYLE_FIELDS)) if (f.includes(k) && k in src && setter in dst && src[k] !== figma.mixed) await dst[setter](src[k])
}
H.copyTextOverrides = async (src: Loose, dst: Loose, ov: Loose) => {
  const mixed = src.fills === figma.mixed || src.fontName === figma.mixed || src.textStyleId === figma.mixed
  if (mixed && src.characters === dst.characters) {
    const segs = src.getStyledTextSegments(['fills', 'fillStyleId', 'fontName', 'textStyleId'])
    await H.loadFonts(dst)
    for (const s of segs) await H.loadFont(s.fontName)
    for (const s of segs) {
      if (src.textStyleId === figma.mixed && s.textStyleId) await dst.setRangeTextStyleIdAsync(s.start, s.end, s.textStyleId)
      if (src.fontName === figma.mixed) dst.setRangeFontName(s.start, s.end, s.fontName)
      if (s.fillStyleId) await dst.setRangeFillStyleIdAsync(s.start, s.end, s.fillStyleId)
      else dst.setRangeFills(s.start, s.end, s.fills)
    }
    return
  }
  const f = ov.get(src.id) || []
  if (f.includes('fills') && src.fills !== figma.mixed) dst.fills = src.fills
  if (f.includes('textStyleId') && src.textStyleId !== figma.mixed) { await H.loadFonts(dst); await dst.setTextStyleIdAsync(src.textStyleId) }
  if (f.includes('fontName') && src.fontName !== figma.mixed) { await H.loadFont(src.fontName); await H.loadFonts(dst); dst.fontName = src.fontName }
}
// Make dst look like src: component/variant, props, texts, visual overrides, recursively.
H.transplant = async (src: Loose, dst: Loose, ov: Loose) => {
  if (src.type === 'INSTANCE' && dst.type === 'INSTANCE') {
    const s = await H.main(src), d = await H.main(dst)
    if (s && d && s.mc.id !== d.mc.id) {
      if (s.set && d.set && s.set.id === d.set.id) {
        const v: Loose = {}
        for (const [k, p] of Object.entries<Loose>(src.componentProperties)) if (p.type === 'VARIANT') v[k] = p.value
        dst.setProperties(v)
      } else dst.swapComponent(s.mc)
    }
    const props: Loose = {}
    for (const [k, p] of Object.entries<Loose>(src.componentProperties))
      if (p.type !== 'VARIANT' && k in dst.componentProperties && dst.componentProperties[k].value !== p.value) props[k] = p.value
    if (Object.keys(props).length) dst.setProperties(props)
  } else if (src.type === 'TEXT' && dst.type === 'TEXT') {
    await H.setText(dst, src.characters)
    await H.copyTextOverrides(src, dst, ov)
  }
  if (src.type !== 'TEXT') await H.copyVisualOverrides(src, dst, ov)
  const sz = ov.get(src.id) || []
  if ((sz.includes('width') || sz.includes('height')) && src.type === 'INSTANCE' && 'resize' in dst) dst.resize(src.width, src.height)
  if (dst.visible !== src.visible) dst.visible = src.visible
  if ('children' in src && 'children' in dst && src.type !== 'TEXT') {
    const sc = src.children, dc = dst.children
    if (sc.length === dc.length) { for (let i = 0; i < sc.length; i++) await H.transplant(sc[i], dc[i], ov) }
    else {
      // Outdated library structure: pair by name, then by kind, hide the rest.
      const used = new Set<string>(), rest: Loose[] = []
      for (const d of dc) {
        const s = sc.find((x: Loose) => x.name === d.name && !used.has(x.id))
        if (s) { used.add(s.id); await H.transplant(s, d, ov) } else rest.push(d)
      }
      const kind = async (n: Loose) => n.type === 'INSTANCE' ? 'I:' + ((await H.main(n)) || {}).setName : n.type
      for (const d of rest) {
        const dk = await kind(d)
        let s: Loose = null
        for (const x of sc) if (!used.has(x.id) && x.visible && await kind(x) === dk) { s = x; break }
        if (s) { used.add(s.id); await H.transplant(s, d, ov) }
        else if (d.visible) d.visible = false
      }
    }
  }
}
H.place = (old: Loose, neu: Loose) => {
  const parent = old.parent
  const index = parent.children.findIndex((c: Loose) => c.id === old.id) // by id: SLOT proxies differ
  if (index < 0) throw new Error('old node not found in its parent')
  parent.insertChild(index, neu)
  const al = 'layoutMode' in parent && parent.layoutMode !== 'NONE'
  if (al && old.layoutPositioning !== 'ABSOLUTE') {
    if (old.layoutSizingHorizontal === 'FIXED') neu.resize(old.width, neu.height)
    neu.layoutSizingHorizontal = old.layoutSizingHorizontal === 'HUG' ? 'FIXED' : old.layoutSizingHorizontal
    neu.layoutAlign = old.layoutAlign
    neu.layoutGrow = old.layoutGrow
  } else {
    if (old.layoutPositioning === 'ABSOLUTE') neu.layoutPositioning = 'ABSOLUTE'
    neu.x = old.x; neu.y = old.y
    neu.resize(old.width, neu.height)
    if ('constraints' in old) neu.constraints = old.constraints
  }
  if (!old.visible) neu.visible = false
  if (old.opacity !== 1) neu.opacity = old.opacity
}
// Figma doesn't reflow hug-content auto-layout after a scripted swap.
H.reflow = (n: Loose) => {
  for (let p: Loose = n; p && p.type !== 'PAGE' && p.type !== 'SECTION'; p = p.parent)
    if ('layoutMode' in p && p.layoutMode !== 'NONE' && p.type !== 'INSTANCE') { try { const s = p.itemSpacing; p.itemSpacing = s + 1; p.itemSpacing = s } catch (_e) { } }
}
const lockingInstance = (n: Loose) => {
  for (let p = n.parent; p && p.type !== 'PAGE'; p = p.parent) {
    if (p.type === 'SLOT') return null
    if (p.type === 'INSTANCE') return p
  }
  return null
}
const screenOf = (n: Loose): Loose => { for (let p: Loose = n.parent; p && p.type !== 'PAGE'; p = p.parent) if (p.parent && (p.parent.type === 'PAGE' || p.parent.type === 'SECTION')) return p; return null }
const pageOf = (n: Loose): Loose => { let p: Loose = n; while (p && p.type !== 'PAGE') p = p.parent; return p }

// =================================================================== plugin UI

const post = (msg: Loose) => figma.ui.postMessage(msg)
const log = (text: string, level?: string) => post({ type: 'log', text, level: level || 'info' })
const tick = () => new Promise<void>((r: Loose) => setTimeout(r, 0))

let running = false
// Last successful check: candidate ids per page, so Replace can skip the search.
let lastCheck: Loose = null
const scopeKey = (recipe: Loose, scope: string) => recipe.id + '|' + scope + '|' + (
  scope === 'selection' ? figma.currentPage.selection.map((n: Loose) => n.id).sort().join(',')
    : scope === 'page' ? figma.currentPage.id : 'file')
const ms = (t: number) => Date.now() - t

async function collect(recipe: Loose, roots: Loose[], stats: Loose) {
  const out: Loose[] = []
  // Hidden layers inside instances can't be rows anyone sees; not walking them
  // is much faster. Search only: building relies on full child lists.
  const prevSkip = figma.skipInvisibleInstanceChildren
  figma.skipInvisibleInstanceChildren = true
  try {
  for (const root of roots) {
    const list = root.type === 'INSTANCE' ? [root] : root.findAllWithCriteria({ types: ['INSTANCE'] })
    let seen = 0
    for (const n of list) {
      // Big pages have tens of thousands of instances: show progress, keep the UI alive.
      if (++seen % 500 === 0) { post({ type: 'progress', text: `Ищу компоненты: ${seen}/${list.length}` }); await tick() }
      // Cheap prefilter: nested parts are handled with their root row.
      const lock = lockingInstance(n)
      const m = await mainCached(n)
      if (!m || !recipe.sourceSets.includes(m.setName)) continue
      if (recipe.sourceKeys && !recipe.sourceKeys.includes((m.set || m.mc).key)) { stats.otherLibrary++; continue }
      if (lock) {
        const lm = await mainCached(lock)
        if (lm && !recipe.sourceSets.includes(lm.setName)) stats.lockedIn[lm.setName] = (stats.lockedIn[lm.setName] || 0) + 1
        continue
      }
      out.push(n)
    }
  }
  } finally { figma.skipInvisibleInstanceChildren = prevSkip }
  return out
}

async function run(mode: string, scope: string, recipeId: string) {
  if (running) return
  running = true
  mainCache.clear()
  const recipe = RECIPES.find((r: Loose) => r.id === recipeId) || RECIPES[0]
  const startPage = figma.currentPage
  const started = Date.now()
  const checkKey = scopeKey(recipe, scope)
  const reuse = mode === 'apply' && lastCheck && lastCheck.key === checkKey && ms(lastCheck.at) < CHECK_TTL_MS ? lastCheck : null
  const check: Loose = mode === 'apply' ? null : { key: checkKey, at: started, pages: {} }
  lastCheck = null // a check is good for one Replace only
  const T: Record<string, number> = { search: 0, extract: 0, build: 0, verify: 0, commit: 0 }
  const report: Loose = {
    tool: 'Migrate component', version: VERSION, recipe: recipe.id, mode, scope,
    file: figma.root.name, startedAt: new Date(started).toISOString(),
    totals: { found: 0, migrated: 0, wouldMigrate: 0, skipped: 0, failed: 0 },
    otherLibrary: 0, lockedIn: {}, skippedByReason: {}, failedByReason: {}, notes: {}, pages: [], items: [],
    reusedCheck: !!reuse, timingMs: T,
  }
  try {
    let plan: Loose[] // [{ page, roots }]
    if (scope === 'selection') {
      const sel = figma.currentPage.selection
      if (!sel.length) throw new Error('ничего не выделено — выделите экраны или секции')
      plan = [{ page: figma.currentPage, roots: sel.slice() }]
    } else if (scope === 'page') plan = [{ page: figma.currentPage, roots: [figma.currentPage] }]
    else plan = figma.root.children.map((p: Loose) => ({ page: p, roots: null }))

    log(`${mode === 'apply' ? 'Замена' : 'Проверка'} · ${recipe.name} · область: ${scope}`)
    const target = recipe.target.isSet
      ? (await figma.importComponentSetByKeyAsync(recipe.target.key)).defaultVariant
      : await figma.importComponentByKeyAsync(recipe.target.key)
    if (reuse) log('Беру строки из последней проверки — поиск пропущен')

    for (const step of plan) {
      const page = step.page
      const cached = reuse ? reuse.pages[page.id] : null
      if (reuse && !cached) continue // nothing there at check time
      if (scope === 'file') { await figma.setCurrentPageAsync(page); step.roots = [page] }
      let stats: Loose = { otherLibrary: 0, lockedIn: {} }
      let candidates: Loose[] = []
      let t = Date.now()
      if (cached) {
        stats = { otherLibrary: cached.otherLibrary, lockedIn: cached.lockedIn }
        for (const id of cached.ids) {
          const n = await figma.getNodeByIdAsync(id)
          if (n && !n.removed && n.type === 'INSTANCE') candidates.push(n)
        }
      } else candidates = await collect(recipe, step.roots, stats)
      T.search += ms(t)
      if (check && candidates.length) check.pages[page.id] = { ids: candidates.map((n: Loose) => n.id), otherLibrary: stats.otherLibrary, lockedIn: stats.lockedIn }
      report.otherLibrary += stats.otherLibrary
      for (const [k, v] of Object.entries<number>(stats.lockedIn)) report.lockedIn[k] = (report.lockedIn[k] || 0) + v
      const pageRow: Loose = { page: page.name, pageId: page.id, found: candidates.length, migrated: 0, skipped: 0, failed: 0 }
      report.pages.push(pageRow)
      if (!candidates.length) continue
      log(`Страница «${page.name}»: найдено ${candidates.length}`)
      report.totals.found += candidates.length

      const touched = new Set<Loose>()
      let i = 0
      for (const old of candidates) {
        i++
        if (i % 20 === 0) { post({ type: 'progress', text: `«${page.name}»: ${i}/${candidates.length}` }); await tick() }
        const scr = screenOf(old)
        t = Date.now()
        const before = H.visibleTexts(old)
        const item: Loose = { page: page.name, screen: scr ? scr.name : '', screenId: scr ? scr.id : null, id: old.id, texts: before.join(' | ').slice(0, 80) }
        const guard = recipe.guardScreen && recipe.guardScreen(scr)
        let ex: Loose
        if (guard) ex = { skip: guard }
        else { try { ex = await recipe.extract(old, H) } catch (e) { ex = { error: 'extract: ' + (e as Error).message } } }
        T.extract += ms(t)
        if (ex.skip || ex.error) {
          const key = ex.skip ? 'skipped' : 'failed'
          const reason = ex.skip || ex.error
          report.totals[key]++; pageRow[key]++
          report[key + 'ByReason'][reason] = (report[key + 'ByReason'][reason] || 0) + 1
          report.items.push(Object.assign(item, { result: key, reason }))
          continue
        }
        if (mode !== 'apply') { report.totals.wouldMigrate++; continue }

        const beforeColours = H.multiColourTexts(old)
        t = Date.now()
        const neu = target.createInstance()
        try {
          H.place(old, neu)
          buildingId = neu.id // after placing: ids may change when moved into a slot
          const commit = await recipe.build(neu, ex.model, H)
          await H.copyVisualOverrides(old, neu, H.overrideMap(old))
          T.build += ms(t); t = Date.now()
          const after = H.visibleTexts(neu)
          if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('text mismatch: [' + before.join(', ') + '] → [' + after.join(', ') + ']')
          const afterColours = H.multiColourTexts(neu)
          for (const [txt, sig] of Object.entries<string>(beforeColours)) if (afterColours[txt] !== sig) throw new Error('multi-colour text lost its colours: "' + txt + '"')
          T.verify += ms(t); t = Date.now()
          if (typeof commit === 'function') await commit()
          if (Math.abs(old.height - neu.height) > 1) ex.model.notes.push('height ' + Math.round(old.height) + '→' + Math.round(neu.height))
          touched.add(neu.parent)
          old.remove()
          report.totals.migrated++; pageRow.migrated++
          for (const n of ex.model.notes) report.notes[n] = (report.notes[n] || 0) + 1
          report.items.push(Object.assign(item, { result: 'migrated', newId: neu.id, notes: ex.model.notes }))
          T.commit += ms(t)
        } catch (e) {
          T.build += ms(t)
          neu.remove()
          report.totals.failed++; pageRow.failed++
          report.failedByReason[(e as Error).message] = (report.failedByReason[(e as Error).message] || 0) + 1
          report.items.push(Object.assign(item, { result: 'failed', reason: (e as Error).message }))
          log(`Откат: ${item.screen} — ${(e as Error).message}`, 'warn')
        } finally { buildingId = '' }
      }
      t = Date.now()
      for (const p of touched) H.reflow(p)
      T.commit += ms(t)
      log(`«${page.name}»: ${mode === 'apply' ? 'заменено ' + pageRow.migrated : 'к замене ' + (candidates.length - pageRow.skipped - pageRow.failed)}, пропущено ${pageRow.skipped}, ошибок ${pageRow.failed}`)
    }
    if (check) lastCheck = check
  } catch (e) {
    report.error = (e as Error).message
    log('Ошибка: ' + (e as Error).message, 'error')
  } finally {
    if (scope === 'file' && figma.currentPage !== startPage) await figma.setCurrentPageAsync(startPage)
    report.finishedAt = new Date().toISOString()
    report.seconds = Math.round((Date.now() - started) / 100) / 10
    report.pages = report.pages.filter((p: Loose) => p.found)
    saveReport(report)
    post({ type: 'done', report })
    announce(report)
    running = false
  }
}

// Canvas toast, so the end is visible even with the plugin panel scrolled or covered.
function announce(report: Loose) {
  const t = report.totals
  try {
    if (report.error) figma.notify('Migrate component: ошибка — ' + report.error, { error: true, timeout: 8000 })
    else if (report.mode === 'apply') figma.notify(`Готово: заменено ${t.migrated} из ${t.found}` + (t.failed ? ` · откатов ${t.failed}` : ''), { timeout: 8000 })
    else figma.notify(`Проверка завершена: можно заменить ${t.wouldMigrate} из ${t.found}`, { timeout: 5000 })
  } catch (_e) { }
}

// Keep the last report in the file so Claude can read it via MCP
// (figma.root.getSharedPluginData('migrate_component', 'last_report')).
function saveReport(report: Loose) {
  const copy: Loose = Object.assign({}, report)
  // Failures and skips matter most; migrated items are summarised if space runs out.
  copy.items = report.items.filter((i: Loose) => i.result !== 'migrated').concat(report.items.filter((i: Loose) => i.result === 'migrated'))
  let json = JSON.stringify(copy)
  while (json.length > MAX_REPORT_CHARS && copy.items.length) {
    copy.items = copy.items.slice(0, Math.floor(copy.items.length * 0.8))
    copy.itemsTruncated = true
    json = JSON.stringify(copy)
  }
  try { figma.root.setSharedPluginData(DATA_NS, REPORT_KEY, json) } catch (e) { log('Не удалось сохранить отчёт в файл: ' + (e as Error).message, 'warn') }
}

async function focus(id: string) {
  const node = await figma.getNodeByIdAsync(id)
  if (!node) { log('Слой не найден (возможно, уже заменён): ' + id, 'warn'); return }
  const page = pageOf(node)
  if (page && page !== figma.currentPage) await figma.setCurrentPageAsync(page)
  figma.currentPage.selection = [node as SceneNode]
  figma.viewport.scrollAndZoomIntoView([node as SceneNode])
}

function sendSelection() { post({ type: 'selection', count: figma.currentPage.selection.length, page: figma.currentPage.name }) }

figma.showUI(__html__, { width: PANEL_WIDTH, height: 420 })

// Handler first, so nothing below can leave the UI without a listener.
figma.ui.onmessage = async (msg: Loose) => {
  try {
    if (msg.type === 'ready') { post({ type: 'init', version: VERSION, recipes: RECIPES.map((r: Loose) => ({ id: r.id, name: r.name })) }); sendSelection(); return }
    if (msg.type === 'resize') { figma.ui.resize(PANEL_WIDTH, Math.max(160, Math.min(900, Math.round(msg.height)))); return }
    if (msg.type === 'run') {
      if (running) { log('Уже выполняется — дождитесь окончания', 'warn'); return }
      await run(msg.mode === 'apply' ? 'apply' : 'dry', msg.scope, msg.recipe)
      return
    }
    if (msg.type === 'focus') { await focus(msg.id); return }
    if (msg.type === 'notify') { figma.notify(msg.text); return }
  } catch (e) {
    log('Ошибка: ' + (e as Error).message, 'error')
    post({ type: 'done', report: null })
  }
}

// key = relaunchButtons command from manifest.json
try { figma.root.setRelaunchData({ '91e527f0-d0e1-456a-9e3c-fa488879636a': 'Заменить устаревшие компоненты' }) } catch (e) { log('Relaunch: ' + (e as Error).message, 'warn') }
figma.on('selectionchange', sendSelection)
figma.on('currentpagechange', sendSelection)
post({ type: 'init', version: VERSION, recipes: RECIPES.map((r: Loose) => ({ id: r.id, name: r.name })) })
sendSelection()
