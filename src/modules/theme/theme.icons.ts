// File-type icon sets as swappable data, each level of the glyph fallback ladder.
// invariant: Appearance is data with a capability fallback (project.invariants.md)
import type { GlyphLevel } from './TerminalCapabilities';

export interface IconSet {
  // by extension (no dot) or special key
  ext: Record<string, string>;
  folderOpen: string;
  folderClosed: string;
  file: string;
}

const NERD: IconSet = {
  ext: {
    ts: '', tsx: '', js: '', jsx: '',
    json: '', md: '', lock: '', sh: '',
    css: '', html: '', vue: '﵂', wasm: '',
    png: '', jpg: '', svg: '', gif: '',
    git: '', gitignore: '', toml: '', yaml: '', yml: '',
  },
  folderOpen: '',
  folderClosed: '',
  file: '',
};

const UNICODE: IconSet = {
  ext: {
    ts: '◆', tsx: '◆', js: '●', jsx: '●', json: '⛃', md: '✎',
    lock: '🔒', sh: '⚙', css: '❖', html: '◈', vue: '◇', wasm: '⬡',
    png: '🖼', jpg: '🖼', svg: '🖼', gif: '🖼',
    git: '⎇', gitignore: '⎇', toml: '⚙', yaml: '⚙', yml: '⚙',
  },
  folderOpen: '▾',
  folderClosed: '▸',
  file: '·',
};

const ASCII: IconSet = {
  ext: {},
  folderOpen: '-',
  folderClosed: '+',
  file: ' ',
};

const SETS: Record<GlyphLevel, IconSet> = {
  nerd: NERD,
  unicode: UNICODE,
  ascii: ASCII,
};

export function iconSetFor(level: GlyphLevel): IconSet {
  return SETS[level];
}

/** Resolve an icon for a filename against a set (extension keyed, with folder/file default). */
export function iconFor(set: IconSet, name: string, isDir: boolean, open = false): string {
  if (isDir) return open ? set.folderOpen : set.folderClosed;
  const dot = name.lastIndexOf('.');
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
  if (name === '.gitignore') return set.ext.git ?? set.file;
  return set.ext[ext] ?? set.file;
}
