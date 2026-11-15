// Line icons for the five words: 24 x 24, 1.75 stroke, drawn in the text colour. Inline SVG,
// so nothing is loaded from elsewhere and they follow light and dark mode.
const PATHS = {
  water: '<path d="M12 2.8C9 6.5 6 9.7 6 13.6a6 6 0 0 0 12 0c0-3.9-3-7.1-6-10.8z"/>',
  food: '<path d="M7 2.5v7.5M4.5 2.5v4.5a2.5 2.5 0 0 0 5 0V2.5M7 10v11.5"/><path d="M17.5 2.5c-1.8.9-3 3.2-3 6v4.5h3v8.5"/>',
  parents: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20.5a6.5 6.5 0 0 1 13 0"/><circle cx="17" cy="9" r="2.5"/><path d="M16.8 14.3a5 5 0 0 1 4.7 5.2"/>',
  sleep: '<path d="M20 14.6A8 8 0 0 1 9.4 4a8 8 0 1 0 10.6 10.6z"/>',
  help: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.8"/><path d="M5.6 5.6l3.7 3.7M14.7 14.7l3.7 3.7M18.4 5.6l-3.7 3.7M9.3 14.7l-3.7 3.7"/>',
};
const FALLBACK = '<circle cx="12" cy="12" r="8"/>';

/** An <svg> element for a word id (any other id gets a plain circle). */
export function icon(id, size = 24) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.75, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(k, v);
  svg.innerHTML = PATHS[id] ?? FALLBACK;          // our own constants, never text from elsewhere
  return svg;
}
