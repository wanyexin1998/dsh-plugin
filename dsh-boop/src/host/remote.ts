/**
 * Typert Remote marker helper.
 *
 * rc.2 marks Remote methods with the `@Remote` decorator; BOOP's source is
 * plain TypeScript (no decorator syntax), so this helper applies the same
 * prototype marker the decorator would. The marker is protocol metadata the
 * Gateway reads through `remoteMethods(service)`; behavior is identical to
 * the decorator path (see @deepseek-ai/dsh-typert-protocol).
 */
import { Remote } from '@deepseek-ai/dsh-typert-protocol'

/** Mark `prototype[name]` as a direct Remote method. */
export function remote(name: string) {
  return function mark(prototype: object): void {
    const method = (prototype as Record<string, unknown>)[name]
    if (typeof method !== 'function') {
      throw new TypeError(`typert remote: ${name} is not a method on ${prototype?.constructor?.name}`)
    }
    const decorator = Remote(name)
    // The decorator's initializer runs per-instance in real decorator semantics
    // (`this` is the instance). Replay it against an object whose prototype is
    // the class prototype so `mark()` receives the same prototype it would.
    decorator(method, {
      kind: 'method',
      name,
      static: false,
      private: false,
      addInitializer: (initializer: () => void) => initializer.call(Object.create(prototype)),
    } as never)
  }
}
