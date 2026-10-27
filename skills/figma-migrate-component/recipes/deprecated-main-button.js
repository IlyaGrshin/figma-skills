// ==== recipe: (Deprecated) Main Button → Fake Main Button ====
// Library: 2 · UI · iOS. Old = "(Deprecated) Main Button": one Button in a Body
// frame, or (Show Sec. Button=True) a nested "(Deprecated) Main Button / Body"
// with Main Button + Sec. Button, stacked (Vertical) or side by side
// (Horizontal), secondary on any side. New = "Fake Main Button" (Type =
// Horizontal | Vertical) with "Button" and "2 Button" slots plus a round
// "More" button. Both sides use the same "Button" component, so buttons are
// transplanted whole (variant, label, icon, spinner).

const BUTTON_SET_KEY = 'dc772ddd1da00f69620276d5284e2c7fb511347f'; // Button

const RECIPE = {
  name: '(Deprecated) Main Button → Fake Main Button',
  sourceSets: ['(Deprecated) Main Button'],
  sourceKeys: ['790b5d425b3e6e443476baba12bea106490b59fa'],
  target: { key: '7dffdb1590d36298975681c4d15a1792f98a8a00', isSet: true },
  guardScreen: (screen) => screen && screen.width <= 360 ? 'android screen (360px) — not an iOS recipe' : null,

  async extract(old, H) {
    const notes = [];
    const p = Object.fromEntries(Object.entries(old.componentProperties).map(([k, v]) => [k.split('#')[0], v.value]));

    // The buttons' container: the Body frame, or the nested Body instance.
    let type = 'Horizontal', box = null;
    for (const c of old.children) {
      if (c.type === 'INSTANCE') {
        const m = await H.main(c);
        // older library versions name it without the "(Deprecated)" prefix
        if (m && m.setName.replace(/^\(Deprecated\)\s+/, '') === 'Main Button / Body') {
          const v = Object.fromEntries(Object.entries(c.componentProperties).map(([k, x]) => [k.split('#')[0], x.value]));
          type = v.Type === 'Vertical' ? 'Vertical' : 'Horizontal';
          box = c; break;
        }
      } else if (c.type === 'FRAME' && c.name === 'Body') { box = c; break; }
    }
    if (!box) return { skip: 'no Body' };
    if (!box.visible) return { skip: 'Body is hidden' };

    // Buttons in their visual order; hidden ones render nothing and are dropped.
    const buttons = [];
    for (const c of box.children) {
      if (c.type !== 'INSTANCE') { if (c.visible) return { skip: `extra layer in Body: ${c.type} "${c.name}"` }; continue; }
      const m = await H.main(c);
      if (!m || (m.set || m.mc).key !== BUTTON_SET_KEY) { if (c.visible) return { skip: `non-Button in Body: ${m ? m.setName : c.name}` }; continue; }
      if (c.visible) buttons.push(c); else notes.push('hidden button dropped');
    }
    if (!buttons.length) return { skip: 'no visible buttons' };
    if (buttons.length > 2) return { skip: `${buttons.length} buttons — Fake Main Button holds 2` };
    if (buttons.length === 1 && p['Show Sec. Button'] === 'True') notes.push('one of two buttons was hidden');

    // The old component painted its own background (F2, often overridden to
    // white). A root fill override is carried over by the engine; the default
    // one is not — Fake Main Button is transparent.
    const ov = H.overrideMap(old);
    const bgOverridden = (ov.get(old.id) || []).some(f => f === 'fills' || f === 'fillStyleId');
    if (!bgOverridden && old.fills !== figma.mixed && old.fills.some(f => f.visible !== false)) notes.push('default background dropped');

    return { model: { notes, ov, type, buttons, home: !!p['Home Indicator'] } };
  },

  async build(neu, m, H) {
    H.setProps(neu, { Type: m.type });
    H.setProps(neu, { 'Show 1 Button': true, 'Show 2 Button': m.buttons.length === 2, 'Show More Button': false, 'Home Indicator': m.home });
    const body = neu.children.find(c => c.name === 'Body');
    if (!body) throw new Error('new Fake Main Button has no Body');
    // The old button had no scroll edge effect; mockups don't want it either.
    const edge = neu.children.find(c => c.name === 'Scroll Edge Effect');
    if (edge) edge.visible = false;
    const slots = [];
    for (const c of body.children) {
      if (c.type !== 'INSTANCE') continue;
      const mm = await H.main(c);
      if (mm && (mm.set || mm.mc).key === BUTTON_SET_KEY) slots.push(c);
    }
    if (slots.length < m.buttons.length) throw new Error(`new Body has ${slots.length} button slots`);
    for (let i = 0; i < m.buttons.length; i++) {
      const src = m.buttons[i], dst = slots[i];
      await H.transplant(src, dst, m.ov);
      // Old secondary buttons hug their label (Body HUG inside a FILL wrapper);
      // keep that, otherwise a tinted text button turns into a full-width one.
      const sb = src.children.find(c => c.type === 'INSTANCE'), db = dst.children.find(c => c.type === 'INSTANCE');
      if (sb && db && sb.layoutSizingHorizontal !== db.layoutSizingHorizontal) {
        db.layoutSizingHorizontal = sb.layoutSizingHorizontal;
        if (dst.layoutMode !== 'NONE' && dst.primaryAxisAlignItems !== src.primaryAxisAlignItems) dst.primaryAxisAlignItems = src.primaryAxisAlignItems;
        m.notes.push(`button ${i + 1} keeps ${sb.layoutSizingHorizontal.toLowerCase()} width`);
      }
    }
  },
};
