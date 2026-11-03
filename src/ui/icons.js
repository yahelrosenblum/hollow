// Line icons for the workspaces. Fixed path data, built as SVG nodes, never parsed from text.

const SVG = 'http://www.w3.org/2000/svg';

const PATHS = {
  listen: ['M12 13.2a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2z', 'M8.2 7.9a5.6 5.6 0 0 0 0 7.6', 'M15.8 7.9a5.6 5.6 0 0 1 0 7.6', 'M5.2 5a9.6 9.6 0 0 0 0 13.4', 'M18.8 5a9.6 9.6 0 0 1 0 13.4'],
  build: ['M4 20l1-4.2L15.6 5.2a2 2 0 0 1 2.8 0l.4.4a2 2 0 0 1 0 2.8L8.2 19 4 20z', 'M13.8 7l3.2 3.2', 'M4 20h16'],
  sources: ['M4.5 9.5h3l4.5-4v13l-4.5-4h-3z', 'M15.6 9a4 4 0 0 1 0 6', 'M18.2 6.4a7.6 7.6 0 0 1 0 11.2'],
  xray: ['M12 19a7 7 0 1 0 0-14 7 7 0 0 0 0 14z', 'M12 2.5v4', 'M12 17.5v4', 'M2.5 12h4', 'M17.5 12h4', 'M12 12.8a.8.8 0 1 0 0-1.6.8.8 0 0 0 0 1.6z'],
  spectrum: ['M4 20V14', 'M8 20V8', 'M12 20V11', 'M16 20V5', 'M20 20V13'],
  lab: ['M3.8 16.5a8.4 8.4 0 1 1 16.4 0', 'M12 16.5l4.2-5.4', 'M12 17.6a1.1 1.1 0 1 0 0-2.2 1.1 1.1 0 0 0 0 2.2z'],
  time: ['M4.6 12a7.4 7.4 0 1 0 2.2-5.2', 'M4 4.5v3.6h3.6', 'M12 8v4.4l3 1.8'],
  studio: ['M12 3.5a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0v-5a3 3 0 0 1 3-3z', 'M6 11.5a6 6 0 0 0 12 0', 'M12 17.5v3'],
  challenges: ['M8 4h8v5.2a4 4 0 0 1-8 0z', 'M8 6H5.2a3 3 0 0 0 2.9 4', 'M16 6h2.8a3 3 0 0 1-2.9 4', 'M12 13.2v3.6', 'M8.5 20h7'],
  perf: ['M3 12h3.6l2.4-6 4 12 2.4-6H21'],
};

export function icon(key) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.6');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of PATHS[key] ?? []) {
    const path = document.createElementNS(SVG, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

// Where the rail draws a divider: after these workspaces, the next group begins.
export const GROUP_ENDS = new Set(['listen', 'sources', 'time', 'challenges']);
