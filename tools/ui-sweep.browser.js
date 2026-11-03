// Opens every workspace at the current window size and measures what a person would trip over:
// sideways scrolling, controls too small to tap, things off screen, unlabelled controls.
(async () => {
  const h = window.hollow;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 80 && !h.active; i += 1) await wait(250);
  await h.dismissWelcome?.();
  await wait(300);
  const report = { width: window.innerWidth, height: window.innerHeight, workspaces: {} };
  const errs = [];
  h.sim.on('gpu-error', (m) => errs.push(m.message));
  window.addEventListener('error', (e) => errs.push(e.message));
  const narrow = window.innerWidth <= 860;
  const minTap = narrow ? 44 : 24;
  const field = () => {
    const s = h.dom.stage.getBoundingClientRect();
    return (s.width * s.height) / (window.innerWidth * window.innerHeight);
  };
  for (const w of h.workspaces) {
    h.openWorkspace(w.key);
    await wait(250);
    const issues = [];
    const doc = document.documentElement;
    if (doc.scrollWidth > window.innerWidth + 1) issues.push(`page scrolls sideways by ${doc.scrollWidth - window.innerWidth}px`);
    const panel = h.dom.panel;
    if (panel.scrollWidth > panel.clientWidth + 1) issues.push(`panel overflows by ${panel.scrollWidth - panel.clientWidth}px`);
    for (const node of panel.querySelectorAll('button, select, input:not([type=file])')) {
      if (node.offsetParent !== null) {
        const r = node.getBoundingClientRect();
        const isCheck = node.type === 'checkbox';
        // Half a pixel of slack: at fractional pixel ratios a 44px control measures 43.997.
        if (!isCheck && !node.classList.contains('link-btn') && r.height < minTap - 0.5) issues.push(`small control "${(node.textContent || node.getAttribute('aria-label') || node.id).trim().slice(0, 24)}": ${Math.round(r.height)}px`);
        const named = (node.textContent || '').trim() || node.getAttribute('aria-label') || node.labels?.[0]?.textContent;
        if (!named) issues.push(`unnamed ${node.tagName.toLowerCase()}`);
        if (r.right > window.innerWidth + 1 || r.left < -1) issues.push(`off screen: "${(node.textContent || '').trim().slice(0, 24)}"`);
      }
    }
    for (const canvas of panel.querySelectorAll('canvas')) {
      const r = canvas.getBoundingClientRect();
      if (r.width > panel.clientWidth + 1) issues.push(`canvas wider than panel: ${Math.round(r.width)}`);
      if (!canvas.getAttribute('aria-label')) issues.push('canvas without a label');
    }
    report.workspaces[w.key] = {
      issues: [...new Set(issues)].slice(0, 8),
      controls: panel.querySelectorAll('button, select, input').length,
      fieldShare: +field().toFixed(2),
    };
  }
  report.errs = errs;
  h.openWorkspace('listen');
  window.hollowSweep = report;
})().catch((error) => {
  window.hollowSweep = { failed: error.message };
});
