// File-type icon sets as swappable data, each level of the glyph fallback ladder.
// invariant: Appearance is data with a capability fallback (project.invariants.md)
import { Static } from '../system/Static';
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

function $iconSetFor(level: GlyphLevel): IconSet {
  return SETS[level];
}

/** Resolve an icon for a filename against a set (extension keyed, with folder/file default). */
function $iconFor(set: IconSet, name: string, isDirectory: boolean, open = false): string {
  if (isDirectory) return open ? set.folderOpen : set.folderClosed;
  const dotIndex = name.lastIndexOf('.');
  const extension = dotIndex >= 0 ? name.slice(dotIndex + 1).toLowerCase() : '';
  if (name === '.gitignore') return set.ext.git ?? set.file;
  return set.ext[extension] ?? set.file;
}

class $ThemeIcons {
  static iconSetFor = $iconSetFor;
  static iconFor = $iconFor;
}

export namespace ThemeIcons {
  export const $Class = $ThemeIcons;
  export const Class = Static($ThemeIcons);
}
