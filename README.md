# Invar — a terminal code editor

Desktop-editor ergonomics, in the terminal. Invar is a fast, mouse- and keyboard-driven
code workspace that runs entirely in your terminal — a file tree, a real text editor with
word wrap and wide/emoji-aware columns, fuzzy go-to-file, find & replace, a git panel with
side-by-side diffs and staging, a command palette, settings, and tabs. Built on
**[Bun](https://bun.com) + [ivue](https://www.npmjs.com/package/ivue) + [OpenTUI](https://github.com/sst/opentui) + Tree-sitter + git**.

The design goal: a newcomer can learn it in ~15 minutes — every action has a visible,
clickable affordance, and no capability requires a memorized motion.

> **Why "Invar"?** [Invar](https://en.wikipedia.org/wiki/Invar) is the iron–nickel alloy
> discovered by Charles Édouard Guillaume in 1896 — named from *invariable*, because its
> thermal expansion is near zero. Precision clocks and measuring instruments were built
> from it for one reason: **it does not drift**. This editor is built the same way — every
> module carries an explicit invariants contract, and a merge gate keeps the structure
> from drifting, no matter how much heat the codebase takes. (Guillaume got the 1920
> Nobel Prize in Physics for the alloy. We just got an editor.)
>
> And the binary is **`iv`** — which is `vi`, reversed. On purpose. Same terminal,
> opposite philosophy: nothing to memorize, everything visible.

## Quickstart

```bash
bun install
bun run start          # open the current directory as the workspace
bun run dev <dir>      # open a specific directory
```

Quit with `Ctrl+Q` or `F10`. Command palette is `F1`; fuzzy go-to-file is `Ctrl+P`.
Full run/build/test instructions live in [`project.build.md`](./project.build.md).

Build a standalone binary:

```bash
bun run build          # → dist/iv  (self-contained executable)
./dist/iv .
```

## Built with Invariant-Based Reasoning (IBR)

This editor is also a demonstration of **IBR** — a method that reduces a problem to the
irreducible structures that actually exist in its domain, then generates from them. Every
module carries a colocated `*.invariants.md` contract; a hard **merge gate** verifies those
invariants by *driving the real user path* (injecting input, reading the rendered
framebuffer) rather than trusting internal values — and blocks any commit that regresses
them. Capabilities live behind a replaceable `Static()` seam, enforced by an AST gate, so
the whole system stays extensible.

The framework itself is here, free to use and build on:

- [`.claude/skills/ibr/IBR.md`](./.claude/skills/ibr/IBR.md) — the IBR framework
- [`.claude/skills/invariants/`](./.claude/skills/invariants/) — the `/invariants` skill (contract schema + checker)

## License

MIT — see [`LICENSE`](./LICENSE). Use it, learn from it, build on it.
