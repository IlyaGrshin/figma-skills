// ==== recipe: (Deprecated) List Item → List Item ====
// Library: 2 · UI · iOS. Old row = container "(Deprecated) List Item / Body" with
// swappable Left / Body / Right parts. New row = "List Item" with nested
// "List Item / Left | Body | Right" variant sets. Texts in both live in Train / Text.

const LEFT = { 'Avatar': 'Avatar', 'Product Icon': 'Coin', 'Transaction Icon': 'Circle Icon', 'Icon Square': 'Icon Square', 'Placeholder': 'Placeholder', 'Icon': 'Icon' };
const BODY_TYPE = { 'Regular': 'Regular', 'Accent': 'Accent', 'Destructive': 'Destructive', 'Text Placeholder': 'Placeholder' };

const RECIPE = {
  name: '(Deprecated) List Item → List Item',
  sourceSets: ['(Deprecated) List Item', '(Deprecated) List Item / Body'],
  // Keys of the iOS library sets above. The Android library reuses the same
  // component names, so names alone are not enough to pick iOS rows.
  sourceKeys: ['d4037f9d28891cc8f824217ffbcff8b4ab2bd4f4', '5ee5ecb2cefb3283024a88e3534058d929cbe24f'],
  target: { key: '308e3f5810c2de64b57ee01fd1c5df259841fce2', isSet: false },
  // iOS screens are 375–440 wide; Android mockups here are 360.
  guardScreen: (screen) => screen && screen.width <= 360 ? 'android screen (360px) — not an iOS recipe' : null,

  async extract(old, H) {
    const ov = H.overrideMap(old);
    const notes = [];
    const text = (root, name) => root.findAllWithCriteria({ types: ['TEXT'] }).find(t => t.name === name && H.isShown(t, root));
    const inst = async (root, setName) => { for (const n of H.shownInstances(root)) { const m = await H.main(n); if (m && m.setName === setName) return n; } };

    let container = (await H.main(old)).setName === '(Deprecated) List Item / Body' ? old : null;
    let left, body, right;
    for (const n of H.shownInstances(old)) {
      const m = await H.main(n); if (!m) continue;
      const s = m.setName.replace(/^\(Deprecated\)\s+/, '');
      const p = Object.fromEntries(Object.entries(n.componentProperties).map(([k, v]) => [k.split('#')[0], v.value]));
      if (s === 'List Item / Body') container = container || n;
      else if (s.startsWith('List Item / Left / ') && !left) left = { n, kind: s.slice(19), p };
      else if (s.startsWith('List Item / Body / ') && !body) body = { n, kind: s.slice(19), p };
      else if (s.startsWith('List Item / Right / ') && !right) right = { n, kind: s.slice(20), p };
    }
    if (!container) return { skip: old.children.length ? 'no container' : 'empty row (no content) — spacer?' };
    const cp = Object.fromEntries(Object.entries(container.componentProperties).map(([k, v]) => [k.split('#')[0], v.value]));
    if (cp['Left Controls']) return { skip: 'left controls — no mapping yet' };
    if (!body) return { skip: 'no body' };

    const model = { ov, notes, separator: !!cp['Separator'] };
    // Old rows paint their own background (Body → section_bg_color); the new
    // List Item is transparent and expects the container to do it.
    if (container.fills !== figma.mixed) {
      const bg = container.fills.filter(f => f.visible !== false);
      if (bg.length) model.bg = bg;
    }

    // Left
    if (left) {
      if (left.kind === 'Search Field') return { skip: 'search field row → use Text Field (Search) instead' };
      if (!LEFT[left.kind]) return { skip: 'left: ' + left.kind };
      if (left.p['Show Badge']) return { skip: 'left: icon badge has no counterpart' };
      // Some Left variants wrap the icon in a Container frame.
      const icon = H.shownInstances(left.n)[0];
      if (!icon) return { skip: 'left: no icon' };
      model.left = { type: LEFT[left.kind], icon };
    }

    // Body
    const b = { badge: null };
    if (body.kind === '1 Line') {
      if (body.p.Dropdown === 'True' || body.p.Counter === 'True') return { skip: 'body: inline dropdown/counter — no counterpart in List Item (library gap)' };
      if (!BODY_TYPE[body.p.Type]) return { skip: 'body type: ' + body.p.Type };
      b.type = BODY_TYPE[body.p.Type];
      b.title = { kind: 'text', node: text(body.n, 'Label') };
    } else if (body.kind === '2 Line') {
      if (body.p.Action === 'True') return { skip: 'body: action link under title — no counterpart in List Item (library gap)' };
      if (body.p.Compact === 'True') notes.push('was compact');
      if (/Medium/.test(body.p.Type)) notes.push('title was medium weight');
      b.type = 'Regular';
      b.title = { kind: 'text', node: text(body.n, 'Label') };
      const sub = body.n.findAllWithCriteria({ types: ['TEXT'] }).find(t => t.name === 'Subtitle' && H.isShown(t, body.n) && t.parent.name !== 'Badge');
      if (sub) b.subtitle = { kind: 'text', node: sub };
    } else if (body.kind === '2 Line · Train') {
      b.type = 'Regular';
      const area = body.n.findOne(n => n.name === 'Label Area');
      const t = area && await inst(area, 'Text');
      if (!t) return { skip: 'body: no title' };
      b.title = { kind: 'inst', node: t };
      const tr = await inst(body.n, 'Train');
      if (tr) b.subtitle = { kind: 'train', node: tr };
    } else return { skip: 'body: ' + body.kind };
    if (!b.title.node) return { skip: 'body: no title' };
    const badge = await inst(body.n, 'Badge');
    if (badge) b.badge = badge;
    b.lines = b.subtitle ? '2 Line ↑' : '1 Line';
    if (b.lines !== '1 Line' && b.type !== 'Regular') return { skip: `body: ${b.type} with 2 lines` };
    model.body = b;

    // Right. A right part whose content is hidden by an override (e.g. Clear
    // with its icon switched off) renders nothing — treat it as no right part.
    const rendersSomething = (n) => n.findAll(x => !('children' in x)).some(x => H.isShown(x, n));
    if (right && !rendersSomething(right.n)) { notes.push('empty right part dropped'); right = null; }
    if (right) {
      const k = right.kind, r = {};
      if (k === 'Input Label') return { skip: 'right: Input Label is a form field → use Text Field' };
      if (k === 'Chevron') Object.assign(r, { lines: '1 Line', type: 'Chevron' });
      else if (k === 'Label') Object.assign(r, { lines: '1 Line', type: 'Label', title: { kind: 'text', node: text(right.n, 'Label') } });
      else if (k === 'Label + Chevron') Object.assign(r, { lines: '1 Line', type: 'Label + Chevron', title: { kind: 'text', node: text(right.n, 'Label') } });
      else if (k === 'Transaction / Subtitle + Label') Object.assign(r, { lines: '2 Line ↑', type: 'Regular', title: { kind: 'text', node: text(right.n, 'Label') }, subtitle: { kind: 'text', node: text(right.n, 'Subtitle') } });
      else if (k === 'Transaction / Subtitle + Train') Object.assign(r, { lines: '2 Line ↑', type: 'Regular', title: { kind: 'text', node: text(right.n, 'Label') }, subtitle: { kind: 'train', node: await inst(right.n, 'Train') } });
      else if (k === 'Transaction / Subtitle + Label + Icon') Object.assign(r, { lines: '2 Line ↑', type: 'Regular + Icon', title: { kind: 'text', node: text(right.n, 'Label') }, subtitle: { kind: 'text', node: text(right.n, 'Subtitle') }, icon: right.n.children.find(c => c.type === 'INSTANCE' && c.visible) });
      else if (k === 'Checkmark') Object.assign(r, { lines: '1 Line', type: 'Checkmark' });
      else if (k === 'Clear') Object.assign(r, { lines: '1 Line', type: 'Clear' });
      else if (k === 'Switch') Object.assign(r, { lines: '1 Line', type: 'Switch', control: await inst(right.n, 'Switch') });
      else if (k === 'Button') Object.assign(r, { lines: '1 Line', type: 'Button', control: await inst(right.n, 'Button') });
      else return { skip: 'right: ' + k };
      if ((r.title && !r.title.node) || (r.subtitle && !r.subtitle.node)) {
        // e.g. subtitle hidden in the old row → fall back to one line
        if (r.title && !r.title.node) return { skip: `right: ${k} without label` };
        if (r.lines === '2 Line ↑') Object.assign(r, { lines: '1 Line', type: 'Label', subtitle: undefined });
      }
      model.right = r;
    }
    return { model };
  },

  async build(neu, m, H) {
    H.setProps(neu, { 'Show Left': !!m.left, 'Show Right': !!m.right, 'Show Separator': m.separator, 'Show Left Control': false });

    // Find parts by their component set, not layer name: layer names differ
    // between the library ("Left") and renamed copies in mockups ("List Item / Left").
    const part = async (setName) => {
      for (const n of neu.findAllWithCriteria({ types: ['INSTANCE'] })) { const mm = await H.main(n); if (mm && mm.setName === setName) return n; }
      throw new Error(`no part ${setName}`);
    };

    // keepCount: the Train also holds other items (Badge=True puts the badge
    // as the 2nd item of Title), so don't collapse it to one label.
    const fill = async (root, slotName, seg, keepCount = false) => {
      const slot = root.findOne(n => n.type === 'INSTANCE' && n.name === slotName);
      if (!slot) throw new Error(`no slot ${slotName}`);
      if (seg.kind === 'train') return H.transplant(seg.node, slot, m.ov);
      if (!keepCount && slot.componentProperties.Count && slot.componentProperties.Count.value !== '1') slot.setProperties({ Count: '1' });
      const label = slot.children.find(c => c.type === 'INSTANCE');
      if (seg.kind === 'inst') return H.transplant(seg.node, label, m.ov);
      const t = H.firstText(label);
      await H.setText(t, seg.node.characters);
      await H.copyTextOverrides(seg.node, t, m.ov);
    };

    if (m.left) {
      const L = await part('List Item / Left');
      H.setProps(L, { Type: m.left.type });
      await H.transplant(m.left.icon, L.children.find(c => c.type === 'INSTANCE'), m.ov);
    }

    const B = await part('List Item / Body');
    H.setProps(B, { Lines: m.body.lines, Type: m.body.type, Badge: m.body.badge ? 'True' : 'False' });
    await fill(B, 'Title', m.body.title, !!m.body.badge);
    if (m.body.subtitle) await fill(B, 'Subtitle', m.body.subtitle);
    if (m.body.badge) {
      let nb; for (const n of H.shownInstances(B)) { const mm = await H.main(n); if (mm && mm.setName === 'Badge') { nb = n; break; } }
      if (!nb) throw new Error('new body has no Badge');
      await H.transplant(m.body.badge, nb, m.ov);
    }

    if (m.right) {
      const R = await part('List Item / Right');
      H.setProps(R, { Lines: m.right.lines, Type: m.right.type });
      if (m.right.title) await fill(R, 'Title', m.right.title);
      if (m.right.subtitle) await fill(R, 'Subtitle', m.right.subtitle);
      if (m.right.control) {
        const slot = R.findOne(n => n.type === 'INSTANCE' && n.name === m.right.type); // "Switch" / "Button"
        if (!slot) throw new Error(`no ${m.right.type} in new Right`);
        await H.transplant(m.right.control, slot, m.ov);
      }
      if (m.right.icon) await H.transplant(m.right.icon, R.findOne(n => n.type === 'INSTANCE' && n.name === 'Icon'), m.ov);
    }

    // Library gap: Root hugs its body, so a tall Left (Avatar/Coin, 60px) with
    // a 1-line body leaves text 4px off-centre and the separator mid-row.
    const root = neu.findOne(n => n.type === 'FRAME' && n.name === 'Root');
    if (root && root.height < neu.height) { root.layoutSizingVertical = 'FILL'; m.notes.push('Root stretched to row height'); }

    // Runs only after verification passed (touches the container, which a
    // rollback of the new instance would not undo).
    // Keep the background: a rounded clipping container is a card → it gets the
    // fill once; otherwise the row itself keeps it.
    return () => {
      if (!m.bg) return;
      const p = neu.parent;
      const hasFill = (n) => 'fills' in n && n.fills !== figma.mixed && n.fills.some(f => f.visible !== false);
      if (hasFill(p)) return;
      if (p.type === 'FRAME' && p.clipsContent && p.cornerRadius !== 0) { p.fills = m.bg; m.notes.push('background moved to container ' + p.name); }
      else { neu.fills = m.bg; m.notes.push('background kept on row'); }
    };
  },
};
