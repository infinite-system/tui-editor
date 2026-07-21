// Maps a file to its language id. The seam where a Tree-sitter grammar would register a
// richer provider; today it selects the immediate tokenizer language.
//
// invariant: Construction goes through overridable seams (project.invariants.md)
import type { LangId } from './Highlighter';

const BY_EXT: Record<string, LangId> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', jsonc: 'json',
  md: 'markdown', markdown: 'markdown',
};

class $LanguageRegistry {
  static forPath(path: string): LangId {
    const dot = path.lastIndexOf('.');
    if (dot < 0) return 'plain';
    const ext = path.slice(dot + 1).toLowerCase();
    return BY_EXT[ext] ?? 'plain';
  }
}

export namespace LanguageRegistry {
  export const $Class = $LanguageRegistry;
  export let Class = $LanguageRegistry;
}
