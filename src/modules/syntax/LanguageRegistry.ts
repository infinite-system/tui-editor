// Maps a file to its language id. The seam where a Tree-sitter grammar would register a
// richer provider; today it selects the immediate tokenizer language.
//
// invariant: Construction goes through overridable seams (project.invariants.md)
import type { LangId } from './Highlighter';

const BY_EXTENSION: Record<string, LangId> = {
  diff: 'diff',
  patch: 'diff',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', jsonc: 'json',
  md: 'markdown', markdown: 'markdown',
  html: 'html', htm: 'html', xml: 'html', svg: 'html',
  css: 'css', scss: 'css', less: 'css', sass: 'css',
  vue: 'vue',
};

class $LanguageRegistry {
  static forPath(path: string): LangId {
    const dotIndex = path.lastIndexOf('.');
    if (dotIndex < 0) return 'plain';
    const extension = path.slice(dotIndex + 1).toLowerCase();
    return BY_EXTENSION[extension] ?? 'plain';
  }
}

export namespace LanguageRegistry {
  export const $Class = $LanguageRegistry;
  export let Class = $LanguageRegistry;
}
