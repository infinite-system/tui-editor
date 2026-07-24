import { afterEach, describe, expect, test } from 'bun:test';
import { AgentProviderRegistry } from './AgentProviderRegistry';

afterEach(() => {
  delete process.env.INVAR_AGENT_ENGINES;
  delete process.env.INVAR_AGENT_PROVIDER;
});

describe('AgentProviderRegistry — the one provider authority (review B6)', () => {
  test('resolve() returns a CONCRETE engine with its binary (auto prefers claude on this box)', () => {
    const resolved = AgentProviderRegistry.Class.resolve('auto');
    expect(['claude', 'codex', 'echo']).toContain(resolved.engine);
    if (resolved.engine !== 'echo') expect(resolved.binaryPath.length).toBeGreaterThan(0);
    expect(resolved.fellBack).toBe(false); // 'auto' never "falls back" — it never named an engine
  });

  test('a requested engine that exists resolves to itself (label ≡ construction, no drift)', () => {
    for (const engine of ['claude', 'codex'] as const) {
      const resolved = AgentProviderRegistry.Class.resolve(engine);
      // On this box both exist; the resolution must honor the request exactly.
      expect(resolved.engine).toBe(engine);
      expect(resolved.fellBack).toBe(false);
    }
  });

  test('INVAR_AGENT_PROVIDER outranks the setting (the driving-smoke force)', () => {
    process.env.INVAR_AGENT_PROVIDER = 'codex';
    expect(AgentProviderRegistry.Class.resolve('claude').engine).toBe('codex');
  });

  test('INVAR_AGENT_ENGINES forces the available list; nextEngine cycles it and wraps', () => {
    process.env.INVAR_AGENT_ENGINES = 'claude,codex';
    expect(AgentProviderRegistry.Class.availableEngines()).toEqual(['claude', 'codex']);
    expect(AgentProviderRegistry.Class.nextEngine('claude')).toBe('codex');
    expect(AgentProviderRegistry.Class.nextEngine('codex')).toBe('claude');
  });

  test('a single-engine box has nothing to cycle to', () => {
    process.env.INVAR_AGENT_ENGINES = 'claude';
    expect(AgentProviderRegistry.Class.nextEngine('claude')).toBeNull();
  });
});
