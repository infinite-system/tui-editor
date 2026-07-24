// Human-readable tool-call summaries — the COLLAPSED one-liner for a tool-use / tool-result, so the
// transcript reads "Reading Foo.ts" or "$ npm test" instead of dumping raw JSON. Pure: tool name + raw
// input in, a concise phrase out (the salient arg per tool). The EXPANDED view still shows the full
// pretty-printed input/output — this is only the folded summary. Unknown tools degrade to their first
// string argument, never the whole JSON blob.
import { Static } from 'ivue/extras';

/** Read an object field as a trimmed string, or null when absent/non-string. */
function stringField(input: unknown, key: string): string | null {
  if (!input || typeof input !== 'object') return null;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** The last path segment of a file path (handles / and \\); the whole string if it has no separator. */
function basename(path: string): string {
  const segments = path.split(/[/\\]+/).filter((segment) => segment.length > 0);
  return segments.length > 0 ? segments[segments.length - 1]! : path;
}

/** The host of a URL, or the raw string when it does not parse. */
function urlHost(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/** Truncate to `limit` code points with an ellipsis. */
function clip(text: string, limit: number): string {
  const codePoints = Array.from(text.trim().replace(/\s+/g, ' '));
  if (codePoints.length <= limit) return codePoints.join('');
  return codePoints.slice(0, Math.max(0, limit - 1)).join('') + '…';
}

/** The first string value found in an object (for unknown tools — one salient arg, not the whole blob). */
function firstStringValue(input: unknown): string | null {
  if (typeof input === 'string') return input;
  if (!input || typeof input !== 'object') return null;
  for (const value of Object.values(input as Record<string, unknown>)) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

/** A concise human phrase for a tool-use, by tool NAME + its salient argument. */
function $summarize(name: string, input: unknown): string {
  const file = () => basename(stringField(input, 'file_path') ?? '?');
  switch (name) {
    case 'Read':
      return `Reading ${file()}`;
    case 'Write':
      return `Writing ${file()}`;
    case 'Edit':
    case 'MultiEdit':
      return `Editing ${file()}`;
    case 'NotebookEdit':
      return `Editing ${basename(stringField(input, 'notebook_path') ?? '?')}`;
    case 'Bash': {
      const command = stringField(input, 'command');
      return command ? `$ ${clip(command, 60)}` : 'Running a command';
    }
    case 'Grep': {
      const pattern = stringField(input, 'pattern') ?? '';
      const path = stringField(input, 'path');
      const where = path && path.length <= 40 ? ` in ${basename(path)}` : '';
      return `Searching "${clip(pattern, 40)}"${where}`;
    }
    case 'Glob':
      return `Finding ${clip(stringField(input, 'pattern') ?? '?', 50)}`;
    case 'LS':
      return `Listing ${basename(stringField(input, 'path') ?? '.')}`;
    case 'WebFetch':
      return `Fetching ${urlHost(stringField(input, 'url') ?? '?')}`;
    case 'WebSearch':
      return `Searching "${clip(stringField(input, 'query') ?? '', 50)}"`;
    case 'Task':
    case 'Agent':
      return clip(stringField(input, 'description') ?? name, 60);
    case 'TodoWrite':
      return 'Updating the plan';
    default: {
      const salient = firstStringValue(input);
      return salient ? clip(salient, 60) : '';
    }
  }
}

/** A short summary of a tool RESULT for the collapsed row: "42 lines" / a short one-liner / "error: …". */
function $summarizeResult(result: string, isError: boolean): string {
  const trimmed = result.trim();
  if (isError) return `error: ${clip(trimmed, 50) || 'failed'}`;
  if (trimmed.length === 0) return 'done';
  const lineCount = trimmed.split('\n').length;
  if (lineCount > 1) return `${lineCount} lines`;
  return clip(trimmed, 50);
}

class $AgentToolSummary {
  static summarize = $summarize;
  static summarizeResult = $summarizeResult;
}

export namespace AgentToolSummary {
  export const $Class = $AgentToolSummary;
  export const Class = Static($AgentToolSummary);
}
