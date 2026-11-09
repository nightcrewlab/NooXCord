/**
 * NooXCord icon set — hand-drawn, 24×24 grid, 1.75 stroke, round caps/joins, currentColor.
 * Each entry is the inner markup of an <svg viewBox="0 0 24 24">.
 * `scripts/export-icons.mjs` writes these to packages/icons/svg/*.svg for design tools.
 */
const slash = `<path d="M3.5 3.5l17 17"/>`;
const micBody = `<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/>`;
const phones = `<path d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="14" width="4.5" height="6.5" rx="1.8"/><rect x="16.5" y="14" width="4.5" height="6.5" rx="1.8"/>`;
const screen = `<rect x="3" y="4" width="18" height="13" rx="2.5"/><path d="M8 21h8M12 17v4"/>`;
const bell = `<path d="M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2.2 2.2 0 0 0 4 0"/>`;
const camBody = `<rect x="2.5" y="6.5" width="13" height="11" rx="2.5"/><path d="M15.5 10.5l5-3v9l-5-3"/>`;
const speakerBody = `<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/>`;

export const icons = {
  mic: micBody,
  "mic-off": `<path d="M15 10V6a3 3 0 0 0-5.6-1.5"/><path d="M9 9v2a3 3 0 0 0 4.7 2.5"/><path d="M5 11a7 7 0 0 0 11.3 5.5M19 11a7 7 0 0 1-.7 3"/><path d="M12 18v3"/>${slash}`,
  headphones: phones,
  "headphones-off": `${phones}${slash}`,
  "screen-share": `${screen}<path d="M12 13.5V8M9.5 10.5L12 8l2.5 2.5"/>`,
  "screen-stop": `${screen}<path d="M10 8.5l4 4M14 8.5l-4 4"/>`,
  monitor: screen,
  window: `<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M3 8.5h18"/><path d="M6 6.3h.01M8.5 6.3h.01"/>`,
  eye: `<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>`,
  hand: `<path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V11"/><path d="M11 10V4a1.5 1.5 0 0 1 3 0v6"/><path d="M14 10V5.5a1.5 1.5 0 0 1 3 0V12"/><path d="M17 9.5a1.5 1.5 0 0 1 3 0V14a7 7 0 0 1-7 7h-1.2a6 6 0 0 1-4.6-2.2L4 15.2a1.6 1.6 0 0 1 2.4-2.1L8 14.5"/>`,
  pointer: `<path d="M5 3.5l13.5 6.8-5.8 1.8-2.4 6.4z"/><path d="M12.7 12.1l5.8 5.8"/>`,
  "phone-hangup": `<path d="M3.2 14.6c-.5-.5-.6-1.4-.1-2C5.4 10 8.6 8.6 12 8.6s6.6 1.4 8.9 4c.5.6.4 1.5-.1 2l-1.6 1.5a1.4 1.4 0 0 1-1.8.1l-2-1.4a1.4 1.4 0 0 1-.6-1.2v-1.8a12 12 0 0 0-5.6 0v1.8c0 .5-.2.9-.6 1.2l-2 1.4a1.4 1.4 0 0 1-1.8-.1z"/>`,
  settings: `<circle cx="12" cy="12" r="3"/><path d="M10.3 3.4h3.4l.6 2.3 1.6.9 2.3-.7 1.7 2.9-1.7 1.7v1.9l1.7 1.7-1.7 2.9-2.3-.7-1.6.9-.6 2.3h-3.4l-.6-2.3-1.6-.9-2.3.7-1.7-2.9 1.7-1.7v-1.9L4.1 8.8l1.7-2.9 2.3.7 1.6-.9z"/>`,
  plus: `<path d="M12 5v14M5 12h14"/>`,
  hash: `<path d="M9.5 3.5l-2 17M16.5 3.5l-2 17M4.5 8.5h16M3.5 15.5h16"/>`,
  speaker: `${speakerBody}<path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>`,
  volume: `${speakerBody}<path d="M16 9.5a3.5 3.5 0 0 1 0 5"/>`,
  "volume-off": `${speakerBody}<path d="M16 9.5l5 5M21 9.5l-5 5"/>`,
  link: `<path d="M10 14a4.2 4.2 0 0 0 6 0l3-3a4.2 4.2 0 0 0-6-6l-1 1"/><path d="M14 10a4.2 4.2 0 0 0-6 0l-3 3a4.2 4.2 0 0 0 6 6l1-1"/>`,
  paperclip: `<path d="M20 11.5l-8.2 8.2a5 5 0 0 1-7-7L13 4.5a3.4 3.4 0 0 1 4.8 4.8l-8.2 8.2a1.7 1.7 0 0 1-2.4-2.4l6.3-6.3"/>`,
  image: `<rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="8.5" cy="9.5" r="1.8"/><path d="M21 15.5l-5-5-9 9.5"/>`,
  file: `<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>`,
  send: `<path d="M21 3L3 10.5l7 2.5 2.5 7z"/><path d="M21 3L10 13"/>`,
  reply: `<path d="M9 7l-5 5 5 5"/><path d="M4 12h10a6 6 0 0 1 6 6v1"/>`,
  edit: `<path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17z"/><path d="M14 8l2.8 2.8"/>`,
  trash: `<path d="M4 7h16M10 3.5h4M6 7l1 12.5a2 2 0 0 0 2 1.5h6a2 2 0 0 0 2-1.5L18 7"/><path d="M10 11v6M14 11v6"/>`,
  pin: `<path d="M9 3.5h6M10 3.5v6L7 13h10l-3-3.5v-6M12 13v7.5"/>`,
  bell,
  "bell-off": `${bell}${slash}`,
  user: `<circle cx="12" cy="8" r="4"/><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0"/>`,
  users: `<circle cx="9" cy="8.5" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M15.5 5.2a3.5 3.5 0 0 1 0 6.6M18 14.2a6.5 6.5 0 0 1 3.5 5.8"/>`,
  "user-plus": `<circle cx="10" cy="8" r="4"/><path d="M3 20.5a7 7 0 0 1 12.5-4.3"/><path d="M19 14v6M16 17h6"/>`,
  crown: `<path d="M3.5 8l4 4L12 5.5l4.5 6.5 4-4-1.5 10h-14z"/><path d="M6 20.5h12"/>`,
  shield: `<path d="M12 3l7.5 3v5.5c0 4.6-3.2 8.3-7.5 9.5-4.3-1.2-7.5-4.9-7.5-9.5V6z"/>`,
  tunnel: `<path d="M3 20.5V12a9 9 0 0 1 18 0v8.5"/><path d="M7.5 20.5v-8a4.5 4.5 0 0 1 9 0v8"/><path d="M2 20.5h20"/>`,
  globe: `<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z"/>`,
  lan: `<rect x="9" y="3" width="6" height="5" rx="1.2"/><rect x="3" y="16" width="6" height="5" rx="1.2"/><rect x="15" y="16" width="6" height="5" rx="1.2"/><path d="M12 8v4M6 16v-2a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v2"/>`,
  copy: `<rect x="8.5" y="8.5" width="12" height="12" rx="2.5"/><path d="M15.5 8.5V6A2.5 2.5 0 0 0 13 3.5H6A2.5 2.5 0 0 0 3.5 6v7A2.5 2.5 0 0 0 6 15.5h2.5"/>`,
  refresh: `<path d="M20 11a8 8 0 0 0-14.5-4.5L4 8.5"/><path d="M4 4v4.5h4.5"/><path d="M4 13a8 8 0 0 0 14.5 4.5l1.5-2"/><path d="M20 20v-4.5h-4.5"/>`,
  check: `<path d="M4.5 12.5l5 5 10-11"/>`,
  close: `<path d="M6 6l12 12M18 6L6 18"/>`,
  "chevron-down": `<path d="M6 9.5l6 6 6-6"/>`,
  "chevron-up": `<path d="M6 14.5l6-6 6 6"/>`,
  "chevron-left": `<path d="M14.5 6l-6 6 6 6"/>`,
  "chevron-right": `<path d="M9.5 6l6 6-6 6"/>`,
  more: `<circle cx="5.5" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.3" fill="currentColor" stroke="none"/>`,
  search: `<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.3-4.3"/>`,
  "live-dot": `<circle cx="12" cy="12" r="3.5" fill="currentColor" stroke="none"/><path d="M6.3 6.3a8 8 0 0 0 0 11.4M17.7 6.3a8 8 0 0 1 0 11.4"/>`,
  overlay: `<rect x="3" y="4" width="18" height="16" rx="2.5"/><rect x="5.5" y="6.5" width="6" height="5" rx="1"/>`,
  signal: `<path d="M5 19v-3M10 19v-7M15 19V8M20 19V4"/>`,
  logout: `<path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4"/><path d="M10 16l-4-4 4-4M6 12h10"/>`,
  at: `<circle cx="12" cy="12" r="3.5"/><path d="M15.5 12v1.5a2.5 2.5 0 0 0 5 0V12a8.5 8.5 0 1 0-3.4 6.8"/>`,
  home: `<path d="M4 10.5L12 4l8 6.5V19a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19z"/><path d="M9.5 20.5v-6h5v6"/>`,
  upload: `<path d="M12 15V4M7.5 8.5L12 4l4.5 4.5"/><path d="M4 15v3.5A2.5 2.5 0 0 0 6.5 21h11a2.5 2.5 0 0 0 2.5-2.5V15"/>`,
  download: `<path d="M12 4v11M7.5 10.5L12 15l4.5-4.5"/><path d="M4 15v3.5A2.5 2.5 0 0 0 6.5 21h11a2.5 2.5 0 0 0 2.5-2.5V15"/>`,
  camera: `<path d="M4 8h3l1.5-2.5h7L17 8h3a1 1 0 0 1 1 1v9.5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13.5" r="3.5"/>`,
  external: `<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/>`,
  lock: `<rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8 10.5v-3a4 4 0 0 1 8 0v3"/>`,
  mail: `<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M3.5 7l8.5 6 8.5-6"/>`,
  alert: `<path d="M12 3.5L2.5 20h19z"/><path d="M12 10v4.5M12 17.5h.01"/>`,
  server: `<rect x="3.5" y="4" width="17" height="7" rx="2"/><rect x="3.5" y="13" width="17" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01M11 7.5h6M11 16.5h6"/>`,
  sliders: `<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>`,
  pip: `<path d="M20 11V6.5A1.5 1.5 0 0 0 18.5 5h-13A1.5 1.5 0 0 0 4 6.5v11A1.5 1.5 0 0 0 5.5 19H10"/><rect x="13" y="13" width="8" height="6" rx="1.25"/>`,
  fullscreen: `<path d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15"/>`,
  "fullscreen-exit": `<path d="M9 4v3.5A1.5 1.5 0 0 1 7.5 9H4M20 9h-3.5A1.5 1.5 0 0 1 15 7.5V4M15 20v-3.5a1.5 1.5 0 0 1 1.5-1.5H20M4 15h3.5A1.5 1.5 0 0 1 9 16.5V20"/>`,
  grid: `<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>`,
  "eye-off": `<path d="M10.6 5.1A9.7 9.7 0 0 1 12 5c5 0 8.5 4.5 9.5 7a13 13 0 0 1-2.6 3.7M6.6 6.7C4.4 8 3 10.2 2.5 12c1 2.5 4.5 7 9.5 7a9.6 9.6 0 0 0 4.9-1.3"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2M4 4l16 16"/>`,
  waveform: `<path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2"/>`,
  video: camBody,
  "video-off": `${camBody}${slash}`,
  "camera-flip": `<path d="M5 10a7 7 0 0 1 12.6-3.2M19 14a7 7 0 0 1-12.6 3.2"/><path d="M18 3.5v3.6h-3.6M6 20.5v-3.6h3.6"/><circle cx="12" cy="12" r="2.2"/>`,
} as const;

export type IconName = keyof typeof icons;
export const iconNames = Object.keys(icons) as IconName[];
