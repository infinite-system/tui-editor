import { test, expect } from 'bun:test';
import { Kernel } from '../Kernel';

test('kernel runs hooks in order at seal and freezes', () => {
  const k = new Kernel.$Class();
  const order: number[] = [];
  k.register(() => order.push(1));
  k.register(() => order.push(2));
  expect(k.isSealed).toBe(false);
  k.seal();
  expect(k.isSealed).toBe(true);
  expect(order).toEqual([1, 2]);
});

test('registering after seal throws', () => {
  const k = new Kernel.$Class();
  k.seal();
  expect(() => k.register(() => {})).toThrow('cannot register after seal');
});

test('assertSealed throws before seal, passes after', () => {
  const k = new Kernel.$Class();
  expect(() => k.assertSealed()).toThrow('kernel is sealed');
  k.seal();
  expect(() => k.assertSealed()).not.toThrow();
});

test('double seal is idempotent', () => {
  const k = new Kernel.$Class();
  let count = 0;
  k.register(() => count++);
  k.seal();
  k.seal();
  expect(count).toBe(1);
});
