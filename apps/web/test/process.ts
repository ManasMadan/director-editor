// Next's client code reads build flags from process.env, which Next's compiler inlines.
// None is set here; this runs before anything imports Next.
(globalThis as { process?: unknown }).process ??= { env: {} };
