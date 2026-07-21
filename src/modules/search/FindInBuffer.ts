import { Reactive } from 'ivue';
import { ref, shallowRef } from 'vue';
import type { TextDocument } from '../editor/TextDocument';
import { u16ToGrapheme } from '../editor/editor.coordinates';

export interface FindInBufferMatch {
  line: number;
  startColumn: number;
  endColumn: number;
}

interface MatchReplacementContext {
  matchedText: string;
  capturedTexts: readonly (string | undefined)[];
  namedCapturedTexts: Readonly<Record<string, string | undefined>> | undefined;
  prefixText: string;
  suffixText: string;
  startUtf16Offset: number;
  endUtf16Offset: number;
}

function escapeRegularExpression(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function expandReplacement(
  replacement: string,
  context: MatchReplacementContext,
): string {
  return replacement.replace(
    /\$(\$|&|`|'|<([^>]+)>|(\d{1,2}))/g,
    (replacementToken, substitutionToken: string, capturedName: string | undefined, capturedNumberText: string | undefined) => {
      if (substitutionToken === '$') return '$';
      if (substitutionToken === '&') return context.matchedText;
      if (substitutionToken === '`') return context.prefixText;
      if (substitutionToken === "'") return context.suffixText;
      if (capturedName !== undefined) {
        if (context.namedCapturedTexts === undefined) return replacementToken;
        return context.namedCapturedTexts[capturedName] ?? '';
      }

      const capturedNumber = Number(capturedNumberText);
      if (capturedNumber > 0 && capturedNumber <= context.capturedTexts.length) {
        return context.capturedTexts[capturedNumber - 1] ?? '';
      }

      if (capturedNumberText?.length === 2) {
        const firstCapturedNumber = Number(capturedNumberText[0]);
        if (firstCapturedNumber > 0 && firstCapturedNumber <= context.capturedTexts.length) {
          return (context.capturedTexts[firstCapturedNumber - 1] ?? '') + capturedNumberText[1];
        }
      }
      return replacementToken;
    },
  );
}

class $FindInBuffer {
  private replacementContexts: MatchReplacementContext[] = [];

  constructor(public readonly document: TextDocument.Instance) {}

  get query() {
    return ref('');
  }

  get replacement() {
    return ref('');
  }

  get caseSensitive() {
    return ref(false);
  }

  get wholeWord() {
    return ref(false);
  }

  get useRegex() {
    return ref(false);
  }

  get matches() {
    return shallowRef<readonly FindInBufferMatch[]>([]);
  }

  get currentMatchIndex() {
    return ref(-1);
  }

  get matchCount(): number {
    return this.matches.value.length;
  }

  /** The range a caller may reveal; scrolling remains the caller's responsibility. */
  get currentMatch(): FindInBufferMatch | null {
    return this.matches.value[this.currentMatchIndex.value] ?? null;
  }

  get currentMatchRange(): FindInBufferMatch | null {
    return this.currentMatch;
  }

  findAll(): readonly FindInBufferMatch[] {
    const regularExpression = this.createRegularExpression();
    if (regularExpression === null) {
      this.clearMatches();
      return this.matches.value;
    }

    const matches: FindInBufferMatch[] = [];
    const replacementContexts: MatchReplacementContext[] = [];
    for (let lineIndex = 0; lineIndex < this.document.lineCount; lineIndex++) {
      const lineText = this.document.line(lineIndex);
      regularExpression.lastIndex = 0;
      let regularExpressionMatch: RegExpExecArray | null;
      while ((regularExpressionMatch = regularExpression.exec(lineText)) !== null) {
        const startUtf16Offset = regularExpressionMatch.index;
        const endUtf16Offset = startUtf16Offset + regularExpressionMatch[0].length;
        matches.push({
          line: lineIndex,
          startColumn: u16ToGrapheme(lineText, startUtf16Offset),
          endColumn: u16ToGrapheme(lineText, endUtf16Offset),
        });
        replacementContexts.push({
          matchedText: regularExpressionMatch[0],
          capturedTexts: regularExpressionMatch.slice(1),
          namedCapturedTexts: regularExpressionMatch.groups,
          prefixText: lineText.slice(0, startUtf16Offset),
          suffixText: lineText.slice(endUtf16Offset),
          startUtf16Offset,
          endUtf16Offset,
        });

        // Global regular expressions do not advance after an empty match.
        if (regularExpressionMatch[0].length === 0) {
          regularExpression.lastIndex = startUtf16Offset + 1;
        }
      }
    }

    this.matches.value = matches;
    this.replacementContexts = replacementContexts;
    this.currentMatchIndex.value = matches.length > 0 ? 0 : -1;
    return this.matches.value;
  }

  next(): FindInBufferMatch | null {
    if (this.matchCount === 0) {
      this.currentMatchIndex.value = -1;
      return null;
    }
    this.currentMatchIndex.value = (this.currentMatchIndex.value + 1 + this.matchCount) % this.matchCount;
    return this.currentMatch;
  }

  previous(): FindInBufferMatch | null {
    if (this.matchCount === 0) {
      this.currentMatchIndex.value = -1;
      return null;
    }
    this.currentMatchIndex.value = (this.currentMatchIndex.value - 1 + this.matchCount) % this.matchCount;
    return this.currentMatch;
  }

  replaceCurrent(): boolean {
    const replacementContext = this.replacementContexts[this.currentMatchIndex.value];
    const currentMatch = this.currentMatch;
    if (currentMatch === null || replacementContext === undefined) return false;

    const replacedMatchIndex = this.currentMatchIndex.value;
    if (currentMatch.startColumn !== currentMatch.endColumn) {
      this.document.deleteRange(
        { line: currentMatch.line, col: currentMatch.startColumn },
        { line: currentMatch.line, col: currentMatch.endColumn },
      );
    }
    const replacementText = expandReplacement(this.replacement.value, replacementContext);
    if (replacementText.length > 0) {
      if (/\r|\n/.test(replacementText)) {
        this.document.insertMultiline(currentMatch.line, currentMatch.startColumn, replacementText);
      } else {
        this.document.insertInline(currentMatch.line, currentMatch.startColumn, replacementText);
      }
    }

    this.findAll();
    if (this.matchCount > 0) {
      this.currentMatchIndex.value = Math.min(replacedMatchIndex, this.matchCount - 1);
    }
    return true;
  }

  replaceAll(): number {
    this.findAll();
    const replacementCount = this.matchCount;
    if (replacementCount === 0) return 0;

    const updatedLines = Array.from(
      { length: this.document.lineCount },
      (_, lineIndex) => this.document.line(lineIndex),
    );
    for (let matchIndex = replacementCount - 1; matchIndex >= 0; matchIndex--) {
      const match = this.matches.value[matchIndex];
      const replacementContext = this.replacementContexts[matchIndex];
      if (match === undefined || replacementContext === undefined) continue;
      const lineText = updatedLines[match.line] ?? '';
      updatedLines[match.line] =
        lineText.slice(0, replacementContext.startUtf16Offset)
        + expandReplacement(this.replacement.value, replacementContext)
        + lineText.slice(replacementContext.endUtf16Offset);
    }

    // TextDocument.replaceAll is the available batch boundary: every replacement is committed as
    // one document mutation (and therefore can be captured as one undo step by the editor caller).
    this.document.replaceAll(updatedLines.join(this.document.eol).split(/\r?\n/));
    this.findAll();
    return replacementCount;
  }

  private createRegularExpression(): RegExp | null {
    if (this.query.value.length === 0) return null;
    const querySource = this.useRegex.value
      ? this.query.value
      : escapeRegularExpression(this.query.value);
    const regularExpressionSource = this.wholeWord.value
      ? `\\b(?:${querySource})\\b`
      : querySource;
    try {
      return new RegExp(regularExpressionSource, this.caseSensitive.value ? 'g' : 'gi');
    } catch {
      return null;
    }
  }

  private clearMatches(): void {
    this.matches.value = [];
    this.replacementContexts = [];
    this.currentMatchIndex.value = -1;
  }
}

export namespace FindInBuffer {
  export const $Class = $FindInBuffer;
  export let Class = Reactive($Class);
  export type Instance = typeof Class.Instance;
}
