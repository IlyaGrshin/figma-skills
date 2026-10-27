// Migrate component — generative plugin version of the figma-migrate-component
// skill (same engine and recipe as skills/figma-migrate-component).
// Replaces deprecated instances with a new component without losing content:
// extract → build → verify (texts + multi-colour texts) → roll back on mismatch.

// The engine walks layers of many node types generically (instances, texts,
// frames, slots), so it uses one loose type instead of per-type unions.
type Loose = ReturnType<typeof JSON.parse>

const VERSION = '1.5.1'
const PANEL_WIDTH = 360
const DATA_NS = 'migrate_component' // shared plugin data namespace for the last report
const REPORT_KEY = 'last_report'
const RECIPE_KEY = 'last_recipe' // clientStorage: the recipe (or 'all') picked last time, per user
const MAX_REPORT_CHARS = 90000
const CHECK_TTL_MS = 15 * 60 * 1000 // Replace reuses a check this fresh instead of searching again
// Share of pixels that may differ (by more than PIXEL_DELTA in a channel) in a pixel check.
const PIXEL_TOLERANCE = 0.005
const PIXEL_DELTA = 24

// ===================================================================== recipes

const LEFT: Record<string, string> = { 'Avatar': 'Avatar', 'Product Icon': 'Coin', 'Transaction Icon': 'Circle Icon', 'Icon Square': 'Icon Square', 'Placeholder': 'Placeholder', 'Icon': 'Icon' }
const BODY_TYPE: Record<string, string> = { 'Regular': 'Regular', 'Accent': 'Accent', 'Destructive': 'Destructive', 'Text Placeholder': 'Placeholder' }

// (Deprecated) List Item → List Item, library 2 · UI · iOS.
const LIST_ITEM: Loose = {
  id: 'deprecated-list-item',
  name: '(Deprecated) List Item → List Item (iOS)',
  short: 'List Item',
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
      // The new title has no Medium variant; build() applies the matching */Medium text style.
      if (/Medium/.test(body.p.Type)) b.medium = true
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
    // A badge inside the subtitle Train travels with the Train; don't add it twice.
    const within = (n: Loose, root: Loose) => { for (let p: Loose = n; p; p = p.parent) if (p.id === root.id) return true; return false }
    const badge = await inst(body.n, 'Badge')
    if (badge && !(b.subtitle && b.subtitle.kind === 'train' && within(badge, b.subtitle.node))) b.badge = badge
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
    // Old "Label Medium" titles used e.g. Body/Medium; give the new title (Body) the same */Medium style.
    const keepMedium = async (root: Loose, oldLabel: Loose) => {
      const slot = root.findOne((n: Loose) => n.type === 'INSTANCE' && n.name === 'Title')
      const t = slot && H.firstText(slot)
      const want = oldLabel.textStyleId
      const oldS: Loose = t && want && want !== figma.mixed ? await figma.getStyleByIdAsync(want) : null
      const newS: Loose = t && t.textStyleId && t.textStyleId !== figma.mixed ? await figma.getStyleByIdAsync(t.textStyleId) : null
      if (oldS && newS && oldS.name === newS.name + '/Medium') {
        await H.loadFonts(t)
        await H.loadFont(oldS.fontName)
        await t.setTextStyleIdAsync(want)
        m.notes.push('title kept medium weight (' + oldS.name + ')')
      } else m.notes.push('title was medium weight')
    }
    const B = await part('List Item / Body')
    H.setProps(B, { Lines: m.body.lines, Type: m.body.type, Badge: m.body.badge ? 'True' : 'False' })
    await fill(B, 'Title', m.body.title, !!m.body.badge)
    if (m.body.medium) await keepMedium(B, m.body.title.node)
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

// Hand-built section → Section (Slots), library 2 · UI · iOS. Old = a plain
// vertical frame (16px side padding) with a "Section / Header & Footer" header,
// a rounded filled card holding the rows and an optional footer. New = "Section"
// instance with Header & Footer and a SLOT for the rows.
const HF_KEY = '76e5b4fe8a0cf330a4b6653dde80db72e2094df8' // Section / Header & Footer
const SECTION: Loose = {
  id: 'section-slots',
  name: 'Section (frame) → Section (Slots, iOS)',
  short: 'Section',
  sourceSets: [],
  target: { key: '18a34cb824f4d3b9ac285d0635d2a28ffe167259', isSet: false },
  guardScreen: (screen: Loose) => screen && screen.width <= 360 ? 'android screen (360px) — not an iOS recipe' : null,

  // The source is a frame, not an instance: frames that hold a header/footer,
  // or a single card with a section's side padding. extract() decides the rest.
  async findSources(root: Loose, H: Loose) {
    const frames: Loose[] = root.type === 'FRAME' ? [root] : []
    if ('findAllWithCriteria' in root) frames.push(...root.findAllWithCriteria({ types: ['FRAME'] }))
    const out: Loose[] = []
    for (const f of frames) {
      if (f.layoutMode !== 'VERTICAL') continue
      let hasHF = false
      for (const c of f.children) if (c.type === 'INSTANCE' && await SECTION.role(c, H)) { hasHF = true; break }
      const loneCard = f.children.length === 1 && SECTION.isCard(f.children[0]) && f.paddingLeft === 16 && f.paddingRight === 16
      if (hasHF || loneCard) out.push(f)
    }
    return out
  },
  // 'header' | 'footer' | null
  async role(n: Loose, H: Loose) {
    if (n.type !== 'INSTANCE') return null
    const m = await H.main(n)
    if (!m || !m.set || m.set.key !== HF_KEY) return null
    return m.variant.includes('Footer') ? 'footer' : 'header'
  },
  isCard: (n: Loose) => n.type === 'FRAME' && n.layoutMode === 'VERTICAL'
    && n.cornerRadius !== figma.mixed && n.cornerRadius >= 8
    && n.fills !== figma.mixed && n.fills.some((f: Loose) => f.visible !== false && f.type === 'SOLID'),

  // Inside slot content the plugin API can't read sublayers of swapped nested
  // instances (they "don't exist"), so the text check covers header/footer
  // only and verify() compares the rows pixel by pixel.
  textFilter: (n: Loose, root: Loose) => !(n.type === 'SLOT' || (n.parent.id === root.id && SECTION.isCard(n))),
  // Each side is exported with the other one hidden, so both sit at the same
  // place: the new section is inserted above the old one, and a screen that
  // clips its content would cut the lower one off. Bytes can differ while the
  // picture is the same (anti-aliasing a fraction of a pixel off), so the UI
  // decodes both and counts pixels that really differ. Fresh copies can still
  // be loading images (coin icons), so a mismatch is checked again after a pause.
  // The library slot has smooth (iOS) corners; it keeps them, so the slot is
  // compared with the card's smoothing for a moment.
  async verify(old: Loose, neu: Loose, m: Loose) {
    const slot = neu.children.find((c: Loose) => c.type === 'SLOT')
    const png = (n: Loose) => n.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 1 } })
    const alone = async (show: Loose, hide: Loose) => { const v = hide.visible; hide.visible = false; try { return await png(show) } finally { hide.visible = v } }
    const wait = (ms: number) => new Promise<void>((r: Loose) => setTimeout(r, ms))
    let why = ''
    const same = async () => {
      const a = await alone(m.card, neu), b = await alone(slot, old)
      if (a.length === b.length && a.every((v: number, i: number) => v === b[i])) return true
      const d = await H.pixelDiff(a, b)
      if (!d) { why = a.length + ' → ' + b.length + ' bytes'; return false }
      if (d.size !== d.size2) { why = 'size ' + d.size + ' → ' + d.size2; return false }
      why = d.diff + ' of ' + d.total + ' px differ, max Δ ' + d.maxDelta
      if (d.diff > d.total * PIXEL_TOLERANCE) return false
      m.notes.push('rows match within anti-aliasing')
      return true
    }
    const smoothing = slot.cornerSmoothing
    if (m.card.cornerSmoothing !== smoothing) { slot.cornerSmoothing = m.card.cornerSmoothing; m.notes.push('corner smoothing ' + m.card.cornerSmoothing + ' → ' + smoothing + ' (library)') }
    try {
      let ok = await same()
      for (const ms of [0, 300, 1000, 2000]) { if (ok) break; await wait(ms); ok = await same() }
      if (!ok) throw new Error('rows render differently in the slot than in the old card (' + why + ')')
    }
    finally { if (slot.cornerSmoothing !== smoothing) slot.cornerSmoothing = smoothing }
  },

  async extract(old: Loose, H: Loose) {
    const all: Loose[] = []
    for (const c of old.children) all.push({ n: c, kind: (await SECTION.role(c, H)) || (SECTION.isCard(c) ? 'card' : 'other') })
    const sig = all.map((p: Loose) => p.kind + (p.n.visible ? '' : ' (hidden)')).join(' + ')
    // Hidden layers other than header/footer (e.g. a spare card) have no place
    // in the Section: they move out next to it, still hidden. Only at the
    // start or the end, so their order relative to the section is kept.
    const spare = (p: Loose) => !p.n.visible && (p.kind === 'card' || p.kind === 'other')
    let a = 0, b = all.length
    while (a < b && spare(all[a])) a++
    while (b > a && spare(all[b - 1])) b--
    const parts = all.slice(a, b)
    if (parts.some(spare)) return { skip: 'hidden layer between header and card: ' + sig }
    const cards = parts.filter((p: Loose) => p.kind === 'card')
    if (parts.some((p: Loose) => p.kind === 'other')) return { skip: 'extra layers next to the card: ' + sig }
    if (cards.length !== 1) return { skip: cards.length ? cards.length + ' cards in one section: ' + sig : 'no card: ' + sig }
    if (!/^(header,)?card(,footer)?$/.test(parts.map((p: Loose) => p.kind).join(','))) return { skip: 'unexpected order: ' + sig }
    const card = cards[0].n
    if (!card.visible) return { skip: 'card is hidden' }
    if (old.itemSpacing !== 0 && parts.length > 1) return { skip: 'gap ' + old.itemSpacing + ' between header and card' }
    if (card.children.some((c: Loose) => c.layoutPositioning === 'ABSOLUTE')) return { skip: 'card has absolutely positioned layers' }
    const header = parts.find((p: Loose) => p.kind === 'header')
    const footer = parts.find((p: Loose) => p.kind === 'footer')
    const bg = old.fills !== figma.mixed ? old.fills.filter((f: Loose) => f.visible !== false) : []
    return { model: { notes: [], card, header: header && header.n, footer: footer && footer.n, bg: bg.length ? old.fills : null, name: old.name,
      above: all.slice(0, a).map((p: Loose) => p.n), below: all.slice(b).map((p: Loose) => p.n) } }
  },

  async build(neu: Loose, m: Loose, H: Loose) {
    H.setProps(neu, { Header: !!m.header, Footer: !!m.footer })
    const slot = neu.children.find((c: Loose) => c.type === 'SLOT')
    if (!slot) throw new Error('new Section has no slot')
    const at = neu.children.indexOf(slot)
    const newHeader = neu.children.slice(0, at).find((c: Loose) => c.type === 'INSTANCE')
    const newFooter = neu.children.slice(at + 1).find((c: Loose) => c.type === 'INSTANCE')
    // Same component set on both sides: copy variant, props, texts.
    if (m.header) await H.transplant(m.header, newHeader, H.overrideMap(m.header))
    if (m.footer) await H.transplant(m.footer, newFooter, H.overrideMap(m.footer))

    // The section frame itself: padding and a background, if any.
    const wrapper = m.card.parent
    for (const k of ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'])
      if (neu[k] !== wrapper[k]) { neu[k] = wrapper[k]; m.notes.push('section ' + k + ' ' + wrapper[k]) }
    if (m.bg) { neu.fills = m.bg; m.notes.push('section background kept') }

    // The card's look goes to the slot only where it differs from the library.
    const same = (a: Loose, b: Loose) => JSON.stringify(a) === JSON.stringify(b)
    const card = m.card
    if (card.fillStyleId && card.fillStyleId !== figma.mixed) { if (slot.fillStyleId !== card.fillStyleId) { await slot.setFillStyleIdAsync(card.fillStyleId); m.notes.push('card fill style kept') } }
    else if (!same(slot.fills, card.fills)) { slot.fills = card.fills; m.notes.push('card fill kept') }
    for (const k of ['cornerRadius', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'itemSpacing', 'primaryAxisAlignItems', 'counterAxisAlignItems', 'strokeAlign'])
      if (card[k] !== figma.mixed && slot[k] !== card[k]) { slot[k] = card[k]; m.notes.push('card ' + k + ' ' + card[k]) }
    for (const k of ['strokes', 'effects'])
      if (card[k].length && !same(slot[k], card[k])) { slot[k] = card[k]; if (k === 'strokes') slot.strokeWeight = card.strokeWeight; m.notes.push('card ' + k + ' kept') }
    if (card.clipsContent !== slot.clipsContent) slot.clipsContent = card.clipsContent

    // Rows: copies of the card's children, hidden ones included, in order.
    // Copies, not moves: on a rollback the old section is still intact.
    for (const c of [...slot.children]) c.remove()
    for (const c of card.children) {
      slot.appendChild(c.clone())
      const k = slot.children[slot.children.length - 1] // fresh handle: the clone's may go stale after append
      if (k.layoutSizingHorizontal !== c.layoutSizingHorizontal) k.layoutSizingHorizontal = c.layoutSizingHorizontal
      if (k.layoutSizingVertical !== c.layoutSizingVertical) k.layoutSizingVertical = c.layoutSizingVertical
    }
    if (card.children.length !== slot.children.length) throw new Error('rows ' + card.children.length + ' → ' + slot.children.length)
    neu.name = m.name

    // Hidden spare layers: copies go next to the section once it is verified.
    if (m.above.length || m.below.length) return () => {
      const out = (n: Loose, at: number) => { const k = n.clone(); neu.parent.insertChild(at, k); k.visible = false; if (neu.parent.layoutMode === 'NONE') { k.x = neu.x + n.x; k.y = neu.y + n.y } }
      for (const n of m.above) out(n, neu.parent.children.indexOf(neu))
      for (const n of [...m.below].reverse()) out(n, neu.parent.children.indexOf(neu) + 1)
      m.notes.push('hidden layers moved next to the section')
    }
  },
}

// (Deprecated) Main Button → Fake Main Button, library 2 · UI · iOS. Old = one
// Button in a Body frame, or (Show Sec. Button=True) a nested Body instance with
// Main Button + Sec. Button, stacked or side by side, secondary on any side.
// New = Type Horizontal | Vertical with "Button", "2 Button" and a round More
// button. Both sides use the same Button component: buttons are transplanted whole.
const BUTTON_SET_KEY = 'dc772ddd1da00f69620276d5284e2c7fb511347f' // Button
const MAIN_BUTTON: Loose = {
  id: 'deprecated-main-button',
  name: '(Deprecated) Main Button → Fake Main Button (iOS)',
  short: 'Main Button',
  sourceSets: ['(Deprecated) Main Button'],
  sourceKeys: ['790b5d425b3e6e443476baba12bea106490b59fa'],
  target: { key: '7dffdb1590d36298975681c4d15a1792f98a8a00', isSet: true },
  guardScreen: (screen: Loose) => screen && screen.width <= 360 ? 'android screen (360px) — not an iOS recipe' : null,

  async extract(old: Loose, H: Loose) {
    const notes: string[] = []
    const p: Loose = {}
    for (const [k, v] of Object.entries<Loose>(old.componentProperties)) p[k.split('#')[0]] = v.value
    // The buttons' container: the Body frame, or the nested Body instance.
    let type = 'Horizontal', box: Loose = null
    for (const c of old.children) {
      if (c.type === 'INSTANCE') {
        const m = await H.main(c)
        // older library versions name it without the "(Deprecated)" prefix
        if (m && m.setName.replace(/^\(Deprecated\)\s+/, '') === 'Main Button / Body') {
          const v: Loose = {}
          for (const [k, x] of Object.entries<Loose>(c.componentProperties)) v[k.split('#')[0]] = x.value
          type = v.Type === 'Vertical' ? 'Vertical' : 'Horizontal'
          box = c; break
        }
      } else if (c.type === 'FRAME' && c.name === 'Body') { box = c; break }
    }
    if (!box) return { skip: 'no Body' }
    if (!box.visible) return { skip: 'Body is hidden' }
    // Buttons in their visual order; hidden ones render nothing and are dropped.
    const buttons: Loose[] = []
    for (const c of box.children) {
      if (c.type !== 'INSTANCE') { if (c.visible) return { skip: 'extra layer in Body: ' + c.type + ' "' + c.name + '"' }; continue }
      const m = await H.main(c)
      if (!m || (m.set || m.mc).key !== BUTTON_SET_KEY) { if (c.visible) return { skip: 'non-Button in Body: ' + (m ? m.setName : c.name) }; continue }
      if (c.visible) buttons.push(c); else notes.push('hidden button dropped')
    }
    if (!buttons.length) return { skip: 'no visible buttons' }
    if (buttons.length > 2) return { skip: buttons.length + ' buttons — Fake Main Button holds 2' }
    if (buttons.length === 1 && p['Show Sec. Button'] === 'True') notes.push('one of two buttons was hidden')
    // A root fill override is carried over by the engine; the component's own
    // default background is not — Fake Main Button is transparent.
    const ov = H.overrideMap(old)
    const bgOverridden = (ov.get(old.id) || []).some((f: string) => f === 'fills' || f === 'fillStyleId')
    if (!bgOverridden && old.fills !== figma.mixed && old.fills.some((f: Loose) => f.visible !== false)) notes.push('default background dropped')
    return { model: { notes, ov, type, buttons, home: !!p['Home Indicator'] } }
  },

  async build(neu: Loose, m: Loose, H: Loose) {
    H.setProps(neu, { Type: m.type })
    H.setProps(neu, { 'Show 1 Button': true, 'Show 2 Button': m.buttons.length === 2, 'Show More Button': false, 'Home Indicator': m.home })
    const body = neu.children.find((c: Loose) => c.name === 'Body')
    if (!body) throw new Error('new Fake Main Button has no Body')
    // The old button had no scroll edge effect; mockups don't want it either.
    const edge = neu.children.find((c: Loose) => c.name === 'Scroll Edge Effect')
    if (edge) edge.visible = false
    const slots: Loose[] = []
    for (const c of body.children) {
      if (c.type !== 'INSTANCE') continue
      const mm = await H.main(c)
      if (mm && (mm.set || mm.mc).key === BUTTON_SET_KEY) slots.push(c)
    }
    if (slots.length < m.buttons.length) throw new Error('new Body has ' + slots.length + ' button slots')
    for (let i = 0; i < m.buttons.length; i++) {
      const src = m.buttons[i], dst = slots[i]
      await H.transplant(src, dst, m.ov)
      // Old secondary buttons may hug their label; keep that width.
      const sb = src.children.find((c: Loose) => c.type === 'INSTANCE'), db = dst.children.find((c: Loose) => c.type === 'INSTANCE')
      if (sb && db && sb.layoutSizingHorizontal !== db.layoutSizingHorizontal) {
        db.layoutSizingHorizontal = sb.layoutSizingHorizontal
        if (dst.layoutMode !== 'NONE' && dst.primaryAxisAlignItems !== src.primaryAxisAlignItems) dst.primaryAxisAlignItems = src.primaryAxisAlignItems
        m.notes.push('button ' + (i + 1) + ' keeps ' + sb.layoutSizingHorizontal.toLowerCase() + ' width')
      }
    }
  },
}

// Several recipes run in this order: List Item before Section, so rows are
// migrated in the old card and Section then copies the new rows into its slot
// (slot content can't be fully read back afterwards).
const RECIPES: Loose[] = [LIST_ITEM, SECTION, MAIN_BUTTON]
const ALL = 'all' // UI choice "all of the below"

// ====================================================================== engine

const H: Loose = {}
const mainOf = async (n: Loose) => {
  const mc = await n.getMainComponentAsync()
  if (!mc) return null
  const set = mc.parent && mc.parent.type === 'COMPONENT_SET' ? mc.parent : null
  return { mc, set, setName: set ? set.name : mc.name, variant: set ? mc.name : '' }
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
// keep: a recipe's textFilter; false prunes the node and its subtree. Pruning
// matters: walking into slot content can throw ("node … does not exist").
H.texts = (root: Loose, keep?: Loose) => {
  if (!keep) return root.findAllWithCriteria({ types: ['TEXT'] })
  const out: Loose[] = []
  const walk = (n: Loose) => { for (const c of n.children) if (keep(c, root)) { if (c.type === 'TEXT') out.push(c); else if ('children' in c) walk(c) } }
  walk(root)
  return out
}
H.visibleTexts = (root: Loose, keep?: Loose) => H.texts(root, keep).filter((t: Loose) => H.isShown(t, root)).map((t: Loose) => t.characters.trim()).filter((s: Loose) => s && !H.isGlyph(s)).sort()
// Texts coloured in parts ("$12.53B" black + "↑ 0.88%" green).
H.multiColourTexts = (root: Loose, keep?: Loose) => {
  const out: Record<string, string> = {}
  for (const t of H.texts(root, keep)) {
    if (!H.isShown(t, root) || t.fills !== figma.mixed) continue
    out[t.characters.trim()] = JSON.stringify(t.getStyledTextSegments(['fills']).map((s: Loose) => [s.start, s.end, s.fills.map((p: Loose) => p.type === 'SOLID' ? [p.color, p.opacity] : p.type)]))
  }
  return out
}
// Only instances have overrides (on a frame the getter throws).
H.overrideMap = (inst: Loose) => new Map<string, string[]>((inst.type === 'INSTANCE' ? inst.overrides : []).map((o: Loose) => [o.id, o.overriddenFields]))
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

// The sandbox can't decode PNGs; the UI iframe does it with a canvas.
// Resolves { size, size2, total, diff, maxDelta }, or null if the UI can't.
const pixelReplies = new Map<number, Loose>()
let pixelSeq = 0
H.pixelDiff = (a: Uint8Array, b: Uint8Array) => new Promise<Loose>((resolve: Loose) => {
  const id = ++pixelSeq
  const done = (r: Loose) => { if (pixelReplies.delete(id)) resolve(r) }
  pixelReplies.set(id, done)
  post({ type: 'pixdiff', id, a, b, delta: PIXEL_DELTA })
  setTimeout(() => done(null), 5000)
})

let running = false
// Last successful check: candidate ids per recipe and page, so Replace can skip the search.
let lastCheck: Loose = null
const scopeKey = (recipes: Loose[], scope: string) => recipes.map((r: Loose) => r.id).join(',') + '|' + scope + '|' + (
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
    // A recipe whose source is not an instance (e.g. a hand-built frame) finds its own sources.
    if (recipe.findSources) {
      for (const n of await recipe.findSources(root, H)) if (!lockingInstance(n)) out.push(n)
      continue
    }
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

const newTotals = () => ({ found: 0, migrated: 0, wouldMigrate: 0, skipped: 0, failed: 0 })

// Runs the picked recipes (in RECIPES order) over the scope in one pass:
// pages outside, recipes inside, so each page is switched to once.
async function run(mode: string, scope: string, recipeIds: string[]) {
  if (running) return
  running = true
  mainCache.clear()
  const recipes = RECIPES.filter((r: Loose) => recipeIds.includes(r.id))
  const startPage = figma.currentPage
  const started = Date.now()
  const checkKey = scopeKey(recipes, scope)
  const reuse = mode === 'apply' && lastCheck && lastCheck.key === checkKey && ms(lastCheck.at) < CHECK_TTL_MS ? lastCheck : null
  const check: Loose = mode === 'apply' ? null : { key: checkKey, at: started, pages: {} }
  lastCheck = null // a check is good for one Replace only
  const T: Record<string, number> = { search: 0, extract: 0, build: 0, verify: 0, commit: 0 }
  const report: Loose = {
    tool: 'Migrate component', version: VERSION, recipe: recipes.map((r: Loose) => r.id).join('+'), mode, scope,
    recipes: recipes.map((r: Loose) => ({ id: r.id, name: r.name, short: r.short, totals: newTotals() })),
    file: figma.root.name, startedAt: new Date(started).toISOString(),
    totals: newTotals(),
    otherLibrary: 0, lockedIn: {}, skippedByReason: {}, failedByReason: {}, notes: {}, pages: [], items: [],
    reusedCheck: !!reuse, timingMs: T,
  }
  try {
    if (!recipes.length) throw new Error('не выбран ни один компонент')
    let plan: Loose[] // [{ page, roots }]
    if (scope === 'selection') {
      const sel = figma.currentPage.selection
      if (!sel.length) throw new Error('ничего не выделено — выделите экраны или секции')
      plan = [{ page: figma.currentPage, roots: sel.slice() }]
    } else if (scope === 'page') plan = [{ page: figma.currentPage, roots: [figma.currentPage] }]
    else plan = figma.root.children.map((p: Loose) => ({ page: p, roots: null }))

    log(`${mode === 'apply' ? 'Замена' : 'Проверка'} · ${recipes.map((r: Loose) => r.short).join(' + ')} · область: ${scope}`)
    const targets = new Map<string, Loose>()
    for (const r of recipes) targets.set(r.id, r.target.isSet
      ? (await figma.importComponentSetByKeyAsync(r.target.key)).defaultVariant
      : await figma.importComponentByKeyAsync(r.target.key))
    if (reuse) log('Беру строки из последней проверки — поиск пропущен')
    const pageKey = (r: Loose, page: Loose) => r.id + '|' + page.id

    for (const step of plan) {
      const page = step.page
      if (reuse && !recipes.some((r: Loose) => reuse.pages[pageKey(r, page)])) continue // nothing there at check time
      if (scope === 'file') { await figma.setCurrentPageAsync(page); step.roots = [page] }
      const pageRow: Loose = { page: page.name, pageId: page.id, found: 0, migrated: 0, skipped: 0, failed: 0 }
      report.pages.push(pageRow)

      for (const recipe of recipes) {
        const rRow = report.recipes.find((r: Loose) => r.id === recipe.id)
        const target = targets.get(recipe.id)
        const bump = (key: string) => { report.totals[key]++; rRow.totals[key]++; if (key in pageRow) pageRow[key]++ }
        const cached = reuse ? reuse.pages[pageKey(recipe, page)] : null
        if (reuse && !cached) continue
        let stats: Loose = { otherLibrary: 0, lockedIn: {} }
        let candidates: Loose[] = []
        let t = Date.now()
        if (cached) {
          stats = { otherLibrary: cached.otherLibrary, lockedIn: cached.lockedIn }
          for (const id of cached.ids) {
            const n = await figma.getNodeByIdAsync(id)
            if (n && !n.removed) candidates.push(n)
          }
        } else candidates = await collect(recipe, step.roots, stats)
        T.search += ms(t)
        if (check && candidates.length) check.pages[pageKey(recipe, page)] = { ids: candidates.map((n: Loose) => n.id), otherLibrary: stats.otherLibrary, lockedIn: stats.lockedIn }
        report.otherLibrary += stats.otherLibrary
        for (const [k, v] of Object.entries<number>(stats.lockedIn)) report.lockedIn[k] = (report.lockedIn[k] || 0) + v
        if (!candidates.length) continue
        log(`«${page.name}» · ${recipe.short}: найдено ${candidates.length}`)
        for (let k = 0; k < candidates.length; k++) bump('found')
        const before0 = { migrated: rRow.totals.migrated, skipped: rRow.totals.skipped, failed: rRow.totals.failed, wouldMigrate: rRow.totals.wouldMigrate }

        const touched = new Set<Loose>()
        let i = 0
        for (const old of candidates) {
          i++
          if (i % 20 === 0) { post({ type: 'progress', text: `«${page.name}» · ${recipe.short}: ${i}/${candidates.length}` }); await tick() }
          const scr = screenOf(old)
          t = Date.now()
          const before = H.visibleTexts(old, recipe.textFilter)
          const item: Loose = { recipe: recipe.id, page: page.name, screen: scr ? scr.name : '', screenId: scr ? scr.id : null, id: old.id, texts: (recipe.textFilter ? H.visibleTexts(old) : before).join(' | ').slice(0, 80) }
          const guard = recipe.guardScreen && recipe.guardScreen(scr)
          let ex: Loose
          if (guard) ex = { skip: guard }
          else { try { ex = await recipe.extract(old, H) } catch (e) { ex = { error: 'extract: ' + (e as Error).message } } }
          T.extract += ms(t)
          if (ex.skip || ex.error) {
            const key = ex.skip ? 'skipped' : 'failed'
            const reason = ex.skip || ex.error
            bump(key)
            report[key + 'ByReason'][reason] = (report[key + 'ByReason'][reason] || 0) + 1
            report.items.push(Object.assign(item, { result: key, reason }))
            continue
          }
          if (mode !== 'apply') { bump('wouldMigrate'); continue }

          const beforeColours = H.multiColourTexts(old, recipe.textFilter)
          t = Date.now()
          const neu = target.createInstance()
          try {
            H.place(old, neu)
            buildingId = neu.id // after placing: ids may change when moved into a slot
            const commit = await recipe.build(neu, ex.model, H)
            await H.copyVisualOverrides(old, neu, H.overrideMap(old))
            T.build += ms(t); t = Date.now()
            const after = H.visibleTexts(neu, recipe.textFilter)
            if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('text mismatch: [' + before.join(', ') + '] → [' + after.join(', ') + ']')
            const afterColours = H.multiColourTexts(neu, recipe.textFilter)
            for (const [txt, sig] of Object.entries<string>(beforeColours)) if (afterColours[txt] !== sig) throw new Error('multi-colour text lost its colours: "' + txt + '"')
            if (recipe.verify) await recipe.verify(old, neu, ex.model, H)
            T.verify += ms(t); t = Date.now()
            if (typeof commit === 'function') await commit()
            if (Math.abs(old.height - neu.height) > 1) ex.model.notes.push('height ' + Math.round(old.height) + '→' + Math.round(neu.height))
            touched.add(neu.parent)
            old.remove()
            bump('migrated')
            for (const n of ex.model.notes) report.notes[n] = (report.notes[n] || 0) + 1
            report.items.push(Object.assign(item, { result: 'migrated', newId: neu.id, notes: ex.model.notes }))
            T.commit += ms(t)
          } catch (e) {
            T.build += ms(t)
            neu.remove()
            bump('failed')
            report.failedByReason[(e as Error).message] = (report.failedByReason[(e as Error).message] || 0) + 1
            report.items.push(Object.assign(item, { result: 'failed', reason: (e as Error).message }))
            log(`Откат: ${item.screen} — ${(e as Error).message}`, 'warn')
          } finally { buildingId = '' }
        }
        t = Date.now()
        for (const p of touched) H.reflow(p)
        T.commit += ms(t)
        const d = (k: string) => rRow.totals[k] - (before0 as Loose)[k]
        log(`«${page.name}» · ${recipe.short}: ${mode === 'apply' ? 'заменено ' + d('migrated') : 'к замене ' + d('wouldMigrate')}, пропущено ${d('skipped')}, ошибок ${d('failed')}`)
      }
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

// The UI opens on the recipe picked last time.
async function sendInit() {
  let recipe: Loose = null
  try { recipe = await figma.clientStorage.getAsync(RECIPE_KEY) } catch (_e) { }
  post({ type: 'init', version: VERSION, recipe, recipes: RECIPES.map((r: Loose) => ({ id: r.id, name: r.name })) })
}

function sendSelection() { post({ type: 'selection', count: figma.currentPage.selection.length, page: figma.currentPage.name }) }

figma.showUI(__html__, { width: PANEL_WIDTH, height: 420 })

// Handler first, so nothing below can leave the UI without a listener.
figma.ui.onmessage = async (msg: Loose) => {
  try {
    if (msg.type === 'ready') { await sendInit(); sendSelection(); return }
    if (msg.type === 'recipe') { if (msg.id === ALL || RECIPES.some((r: Loose) => r.id === msg.id)) await figma.clientStorage.setAsync(RECIPE_KEY, msg.id); return }
    if (msg.type === 'pixdiff') { const r = pixelReplies.get(msg.id); if (r) r(msg.result); return }
    if (msg.type === 'resize') { figma.ui.resize(PANEL_WIDTH, Math.max(160, Math.min(900, Math.round(msg.height)))); return }
    if (msg.type === 'run') {
      if (running) { log('Уже выполняется — дождитесь окончания', 'warn'); return }
      await run(msg.mode === 'apply' ? 'apply' : 'dry', msg.scope, msg.recipe === ALL ? RECIPES.map((r: Loose) => r.id) : [msg.recipe])
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
sendInit().then(sendSelection)
