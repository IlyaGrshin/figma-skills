// ==== recipe: hand-built section → Section (Slots) ====
// Library: 2 · UI · iOS. Old section = a plain vertical frame (16px side
// padding) holding a "Section / Header & Footer" header, a rounded filled
// "Card" frame with the rows, and optionally a footer. New = "Section"
// instance: Header & Footer instances + a SLOT (white, r26) for the rows.
// The source is a frame, not an instance, so the recipe finds its own sources.

const HF_KEY = '76e5b4fe8a0cf330a4b6653dde80db72e2094df8'; // Section / Header & Footer

const RECIPE = {
  name: 'Section (frame) → Section (Slots)',
  sourceSets: [],
  target: { key: '18a34cb824f4d3b9ac285d0635d2a28ffe167259', isSet: false },
  guardScreen: (screen) => screen && screen.width <= 360 ? 'android screen (360px) — not an iOS recipe' : null,

  // Frames that look like a section: they hold a header/footer instance, or a
  // single card with a section's side padding. extract() decides the rest.
  async findSources(root, H) {
    const frames = root.type === 'FRAME' ? [root] : [];
    if ('findAllWithCriteria' in root) frames.push(...root.findAllWithCriteria({ types: ['FRAME'] }));
    const out = [];
    for (const f of frames) {
      if (f.layoutMode !== 'VERTICAL') continue;
      let hasHF = false;
      for (const c of f.children) if (c.type === 'INSTANCE' && await RECIPE.role(c, H)) { hasHF = true; break; }
      const loneCard = f.children.length === 1 && RECIPE.isCard(f.children[0]) && f.paddingLeft === 16 && f.paddingRight === 16;
      if (hasHF || loneCard) out.push(f);
    }
    return out;
  },

  // 'header' | 'footer' | null
  async role(n, H) {
    if (n.type !== 'INSTANCE') return null;
    const m = await H.main(n);
    if (!m || !m.set || m.set.key !== HF_KEY) return null;
    return m.variant.includes('Footer') ? 'footer' : 'header';
  },

  isCard: (n) => n.type === 'FRAME' && n.layoutMode === 'VERTICAL'
    && n.cornerRadius !== figma.mixed && n.cornerRadius >= 8
    && n.fills !== figma.mixed && n.fills.some(f => f.visible !== false && f.type === 'SOLID'),

  // Inside slot content the plugin API can't read sublayers of swapped nested
  // instances (they "don't exist"), so the text check covers header/footer
  // only and verify() compares the rows pixel by pixel.
  textFilter: (n, root) => !(n.type === 'SLOT' || (n.parent.id === root.id && RECIPE.isCard(n))),

  // Each side is exported with the other one hidden, so both sit at the same
  // place: the new section is inserted above the old one, and a screen that
  // clips its content would cut the lower one off. Fresh copies can still be
  // loading images (coin icons), so a mismatch is checked again after a pause.
  // The library slot has smooth (iOS) corners; it keeps them, so the slot is
  // compared with the card's smoothing for a moment.
  async verify(old, neu, m) {
    const slot = neu.children.find(c => c.type === 'SLOT');
    const png = (n) => n.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 1 } });
    const alone = async (show, hide) => { const v = hide.visible; hide.visible = false; try { return await png(show); } finally { hide.visible = v; } };
    const wait = (ms) => new Promise(r => typeof setTimeout === 'function' ? setTimeout(r, ms) : r());
    let sizes = '';
    const same = async () => { const a = await alone(m.card, neu), b = await alone(slot, old); sizes = `${a.length} → ${b.length} bytes`; return a.length === b.length && a.every((v, i) => v === b[i]); };
    const smoothing = slot.cornerSmoothing;
    if (m.card.cornerSmoothing !== smoothing) { slot.cornerSmoothing = m.card.cornerSmoothing; m.notes.push(`corner smoothing ${m.card.cornerSmoothing} → ${smoothing} (library)`); }
    try {
      let ok = await same();
      for (const ms of [0, 300, 1000, 2000]) { if (ok) break; await wait(ms); ok = await same(); }
      if (!ok) throw new Error(`rows render differently in the slot than in the old card (${sizes})`);
    }
    finally { if (slot.cornerSmoothing !== smoothing) slot.cornerSmoothing = smoothing; }
  },

  async extract(old, H) {
    const all = [];
    for (const c of old.children) all.push({ n: c, kind: (await RECIPE.role(c, H)) || (RECIPE.isCard(c) ? 'card' : 'other') });
    const sig = all.map(p => p.kind + (p.n.visible ? '' : ' (hidden)')).join(' + ');
    // Hidden layers other than header/footer (e.g. a spare card) have no place
    // in the Section: they move out next to it, still hidden. Only at the
    // start or the end, so their order relative to the section is kept.
    const spare = (p) => !p.n.visible && (p.kind === 'card' || p.kind === 'other');
    let a = 0, b = all.length;
    while (a < b && spare(all[a])) a++;
    while (b > a && spare(all[b - 1])) b--;
    const parts = all.slice(a, b);
    if (parts.some(spare)) return { skip: `hidden layer between header and card: ${sig}` };
    const cards = parts.filter(p => p.kind === 'card');
    if (parts.some(p => p.kind === 'other')) return { skip: `extra layers next to the card: ${sig}` };
    if (cards.length !== 1) return { skip: cards.length ? `${cards.length} cards in one section: ${sig}` : `no card: ${sig}` };
    const kinds = parts.map(p => p.kind).join(',');
    if (!/^(header,)?card(,footer)?$/.test(kinds)) return { skip: `unexpected order: ${sig}` };
    const card = cards[0].n;
    if (!card.visible) return { skip: 'card is hidden' };
    if (old.itemSpacing !== 0 && parts.length > 1) return { skip: `gap ${old.itemSpacing} between header and card` };
    if (card.children.some(c => c.layoutPositioning === 'ABSOLUTE')) return { skip: 'card has absolutely positioned layers' };

    const notes = [];
    const header = parts.find(p => p.kind === 'header');
    const footer = parts.find(p => p.kind === 'footer');
    const bg = old.fills !== figma.mixed ? old.fills.filter(f => f.visible !== false) : [];
    return { model: { notes, card, header: header && header.n, footer: footer && footer.n, bg: bg.length ? old.fills : null, name: old.name,
      above: all.slice(0, a).map(p => p.n), below: all.slice(b).map(p => p.n) } };
  },

  async build(neu, m, H) {
    H.setProps(neu, { Header: !!m.header, Footer: !!m.footer });
    const slot = neu.children.find(c => c.type === 'SLOT');
    if (!slot) throw new Error('new Section has no slot');
    const at = neu.children.indexOf(slot);
    const newHeader = neu.children.slice(0, at).find(c => c.type === 'INSTANCE');
    const newFooter = neu.children.slice(at + 1).find(c => c.type === 'INSTANCE');
    // The header/footer are the same component set on both sides: copy variant, props, texts.
    if (m.header) await H.transplant(m.header, newHeader, H.overrideMap(m.header));
    if (m.footer) await H.transplant(m.footer, newFooter, H.overrideMap(m.footer));

    // The section frame itself: side/vertical padding and a background, if any.
    const wrapper = m.card.parent;
    for (const k of ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'])
      if (neu[k] !== wrapper[k]) { neu[k] = wrapper[k]; m.notes.push(`section ${k} ${wrapper[k]}`); }
    if (m.bg) { neu.fills = m.bg; m.notes.push('section background kept'); }

    // The card's look goes to the slot only where it differs from the library.
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const card = m.card;
    if (card.fillStyleId && card.fillStyleId !== figma.mixed) { if (slot.fillStyleId !== card.fillStyleId) { await slot.setFillStyleIdAsync(card.fillStyleId); m.notes.push('card fill style kept'); } }
    else if (!same(slot.fills, card.fills)) { slot.fills = card.fills; m.notes.push('card fill kept'); }
    for (const k of ['cornerRadius', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'itemSpacing', 'primaryAxisAlignItems', 'counterAxisAlignItems', 'strokeAlign'])
      if (card[k] !== figma.mixed && slot[k] !== card[k]) { slot[k] = card[k]; m.notes.push(`card ${k} ${card[k]}`); }
    for (const k of ['strokes', 'effects'])
      if (card[k].length && !same(slot[k], card[k])) { slot[k] = card[k]; if (k === 'strokes') slot.strokeWeight = card.strokeWeight; m.notes.push(`card ${k} kept`); }
    if (card.clipsContent !== slot.clipsContent) slot.clipsContent = card.clipsContent;

    // Rows: copies of the card's children, hidden ones included, in order.
    // Copies, not moves: on a rollback the old section is still intact.
    for (const c of [...slot.children]) c.remove();
    for (const c of card.children) {
      slot.appendChild(c.clone());
      const k = slot.children[slot.children.length - 1]; // fresh handle: the clone's may go stale after append
      if (k.layoutSizingHorizontal !== c.layoutSizingHorizontal) k.layoutSizingHorizontal = c.layoutSizingHorizontal;
      if (k.layoutSizingVertical !== c.layoutSizingVertical) k.layoutSizingVertical = c.layoutSizingVertical;
    }
    if (card.children.length !== slot.children.length) throw new Error(`rows ${card.children.length} → ${slot.children.length}`);
    neu.name = m.name;

    // Hidden spare layers: copies go next to the section once it is verified.
    if (m.above.length || m.below.length) return () => {
      const out = (n, at) => { const k = n.clone(); neu.parent.insertChild(at, k); k.visible = false; if (neu.parent.layoutMode === 'NONE') { k.x = neu.x + n.x; k.y = neu.y + n.y; } };
      for (const n of m.above) out(n, neu.parent.children.indexOf(neu));
      for (const n of [...m.below].reverse()) out(n, neu.parent.children.indexOf(neu) + 1);
      m.notes.push('hidden layers moved next to the section');
    };
  },
};
