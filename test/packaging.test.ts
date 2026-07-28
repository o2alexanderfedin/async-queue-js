/**
 * Source-level tests for the cross-copy `instanceof` brand on QueueClosedError.
 *
 * Context: v2 ships both an ESM and a CommonJS build behind an exports map. A
 * dependency graph can load both halves at once — an ESM app `import`s the
 * package while one of its CommonJS dependencies `require`s it — producing two
 * QueueClosedError classes with two distinct prototypes. A plain prototype-chain
 * `instanceof` tests against whichever copy the *checking* code imported, so an
 * error thrown by the other copy fails the check and falls through the caller's
 * `else { throw err }`. Since `err.item` is the only handle on a payload the
 * queue refused, that is silent data loss.
 *
 * `QueueClosedError` therefore installs a `Symbol.hasInstance` that tests a
 * `Symbol.for`-keyed brand instead of the prototype chain.
 *
 * The genuine two-copy proof requires two separately-loaded builds and lives in
 * `scripts/verify-packaging.js` (`npm run verify:packaging`), which packs the
 * real tarball and loads dist/esm and dist/cjs into one process. What is tested
 * here is everything that relaxed check must NOT break.
 */
import { AsyncQueue, QueueClosedError } from '../src/index';

/** The registry key the brand uses. Recomputing it is exactly what a second copy does. */
const BRAND = Symbol.for('@alexanderfedin/async-queue:QueueClosedError:v2');

describe('QueueClosedError cross-copy instanceof', () => {
  it('accepts its own instances', () => {
    expect(new QueueClosedError('x')).toBeInstanceOf(QueueClosedError);
  });

  it('is still an Error, so generic error handling is unaffected', () => {
    const err = new QueueClosedError('x');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('QueueClosedError');
    expect(err.message).toBe('Queue is closed');
    expect(err.stack).toBeTruthy();
  });

  it('accepts a branded error from a hypothetical second copy of the module', () => {
    // Exactly what the other half of the dual build produces: same shape, same
    // registry-keyed brand, unrelated prototype.
    class ForeignQueueClosedError extends Error {
      readonly item: unknown;
      constructor(item: unknown) {
        super('Queue is closed');
        this.name = 'QueueClosedError';
        this.item = item;
      }
    }
    Object.defineProperty(ForeignQueueClosedError.prototype, BRAND, {
      value: true,
      enumerable: false
    });

    const foreign = new ForeignQueueClosedError('payload');

    // The check that used to fail silently.
    expect(foreign).toBeInstanceOf(QueueClosedError);
    // And the reason it matters: the payload is reachable.
    expect((foreign as QueueClosedError<string>).item).toBe('payload');
    // The prototype chains really are unrelated — this is not a trivially true test.
    expect(Object.getPrototypeOf(foreign)).not.toBe(QueueClosedError.prototype);
    expect(foreign instanceof (QueueClosedError as unknown as { prototype: object }).constructor).toBe(
      false
    );
  });

  it.each([
    ['a plain Error', new Error('Queue is closed')],
    ['a TypeError', new TypeError('nope')],
    ['a bare object', {}],
    ['an object with a lookalike message', { message: 'Queue is closed', name: 'QueueClosedError' }],
    ['null', null],
    ['undefined', undefined],
    ['a string', 'Queue is closed'],
    ['a number', 42],
    ['a function', () => undefined]
  ])('rejects %s', (_label, value) => {
    expect(value instanceof QueueClosedError).toBe(false);
  });

  it('does not throw when the left operand is a primitive', () => {
    // `as unknown` only to get past TS2358; the point is the runtime behaviour.
    expect(() => (0 as unknown) instanceof QueueClosedError).not.toThrow();
    expect(() => (Symbol('s') as unknown) instanceof QueueClosedError).not.toThrow();
    expect(() => (false as unknown) instanceof QueueClosedError).not.toThrow();
  });

  describe('subclasses keep exact prototype-chain semantics', () => {
    class AppQueueClosedError<T> extends QueueClosedError<T> {}
    class OtherQueueClosedError<T> extends QueueClosedError<T> {}

    it('a subclass instance is still a QueueClosedError', () => {
      expect(new AppQueueClosedError('x')).toBeInstanceOf(QueueClosedError);
    });

    it('a subclass instance is an instance of its own subclass', () => {
      expect(new AppQueueClosedError('x')).toBeInstanceOf(AppQueueClosedError);
    });

    it('a base QueueClosedError is NOT an instance of the subclass', () => {
      // The bug the `this !== QueueClosedError` guard prevents: if the relaxed
      // brand check were inherited, this would wrongly answer true.
      expect(new QueueClosedError('x') instanceof AppQueueClosedError).toBe(false);
    });

    it('sibling subclasses stay distinct', () => {
      expect(new AppQueueClosedError('x') instanceof OtherQueueClosedError).toBe(false);
      expect(new OtherQueueClosedError('x') instanceof AppQueueClosedError).toBe(false);
    });
  });

  it('the brand is non-enumerable, so it cannot leak into serialisation or key walks', () => {
    const err = new QueueClosedError('x');
    expect(Object.keys(err)).not.toContain(BRAND);
    expect(Object.getOwnPropertySymbols(err)).not.toContain(BRAND);
    expect(
      Object.getOwnPropertyDescriptor(QueueClosedError.prototype, BRAND)?.enumerable
    ).toBe(false);
  });

  it('narrows in a catch block, so err.item stays reachable', async () => {
    // Type-level narrowing is a compile-time property; this file failing to
    // compile is itself the assertion. The runtime half is checked too.
    const queue = new AsyncQueue<string>(1);
    await queue.enqueue('first');
    const blocked = queue.enqueue('second');
    queue.close();

    let recovered: string | undefined;
    try {
      await blocked;
    } catch (err) {
      if (err instanceof QueueClosedError) {
        recovered = err.item as string;
      }
    }
    expect(recovered).toBe('second');
  });
});
