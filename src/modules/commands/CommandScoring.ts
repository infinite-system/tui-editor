import { Static } from '../system/Static';

/** Case-insensitive subsequence match; returns a score (lower = tighter) or -1. */
function $fuzzyScore(query: string, text: string): number {
  if (!query) return 0;
  const loweredQuery = query.toLowerCase();
  const loweredText = text.toLowerCase();
  let queryIndex = 0;
  let textIndex = 0;
  let score = 0;
  let lastMatch = -1;
  while (queryIndex < loweredQuery.length && textIndex < loweredText.length) {
    if (loweredQuery[queryIndex] === loweredText[textIndex]) {
      if (lastMatch >= 0) score += textIndex - lastMatch;
      lastMatch = textIndex;
      queryIndex++;
    }
    textIndex++;
  }
  return queryIndex === loweredQuery.length ? score : -1;
}

class $CommandScoring {
  static fuzzyScore = $fuzzyScore;
}

export namespace CommandScoring {
  export const $Class = $CommandScoring;
  export const Class = Static($CommandScoring);
}
