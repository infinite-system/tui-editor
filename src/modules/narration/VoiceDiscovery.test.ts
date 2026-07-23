// Voice discovery + selected-voice resolution against a seeded fake voices directory (top level +
// library/ subdir). No engine, no audio — pure filesystem probe.
import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VoiceDiscovery } from './VoiceDiscovery';
import { SystemTtsBackend } from './SystemTtsBackend';

let dataHome = '';
const savedXdg = process.env.XDG_DATA_HOME;
const savedPiper = process.env.INVAR_PIPER_MODEL;

beforeEach(() => {
  dataHome = mkdtempSync(join(tmpdir(), 'invar-voices-'));
  const voices = join(dataHome, 'piper-voices');
  mkdirSync(join(voices, 'library'), { recursive: true });
  // Two top-level voices + one stashed in library/ + a non-onnx file that must be ignored.
  writeFileSync(join(voices, 'en_US-amy-medium.onnx'), 'x');
  writeFileSync(join(voices, 'en_GB-alan-low.onnx'), 'x');
  writeFileSync(join(voices, 'library', 'de_DE-thorsten-high.onnx'), 'x');
  writeFileSync(join(voices, 'readme.txt'), 'not a voice');
  process.env.XDG_DATA_HOME = dataHome;
  delete process.env.INVAR_PIPER_MODEL;
});

afterEach(() => {
  if (savedXdg === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = savedXdg;
  if (savedPiper === undefined) delete process.env.INVAR_PIPER_MODEL;
  else process.env.INVAR_PIPER_MODEL = savedPiper;
  rmSync(dataHome, { recursive: true, force: true });
});

test('discover finds every *.onnx across the dir AND library/, ignoring non-onnx, sorted by name', () => {
  expect(VoiceDiscovery.Class.names()).toEqual(['de_DE-thorsten-high', 'en_GB-alan-low', 'en_US-amy-medium']);
});

test('options prepend "" (auto) to the discovered names', () => {
  expect(VoiceDiscovery.Class.options()).toEqual(['', 'de_DE-thorsten-high', 'en_GB-alan-low', 'en_US-amy-medium']);
});

test('resolvePath returns the selected voice, including one inside library/', () => {
  expect(VoiceDiscovery.Class.resolvePath('en_US-amy-medium')).toBe(join(dataHome, 'piper-voices', 'en_US-amy-medium.onnx'));
  expect(VoiceDiscovery.Class.resolvePath('de_DE-thorsten-high')).toBe(join(dataHome, 'piper-voices', 'library', 'de_DE-thorsten-high.onnx'));
});

test('resolvePath falls back to the first discovered voice when the selection is empty or unknown', () => {
  const first = join(dataHome, 'piper-voices', 'library', 'de_DE-thorsten-high.onnx'); // sorts first
  expect(VoiceDiscovery.Class.resolvePath('')).toBe(first);
  expect(VoiceDiscovery.Class.resolvePath('no-such-voice')).toBe(first);
});

test('resolvePath returns null when no voices are installed', () => {
  process.env.XDG_DATA_HOME = mkdtempSync(join(tmpdir(), 'invar-empty-'));
  expect(VoiceDiscovery.Class.resolvePath('anything')).toBeNull();
});

test('SystemTtsBackend.resolvePiperModel honors the selected voice, else first-found', () => {
  expect(SystemTtsBackend.Class.resolvePiperModel('en_GB-alan-low')).toBe(join(dataHome, 'piper-voices', 'en_GB-alan-low.onnx'));
  expect(SystemTtsBackend.Class.resolvePiperModel('')).toBe(join(dataHome, 'piper-voices', 'library', 'de_DE-thorsten-high.onnx'));
});

test('SystemTtsBackend.resolvePiperModel: an explicit INVAR_PIPER_MODEL overrides discovery', () => {
  process.env.INVAR_PIPER_MODEL = '/custom/voice.onnx';
  expect(SystemTtsBackend.Class.resolvePiperModel('en_US-amy-medium')).toBe('/custom/voice.onnx');
});
