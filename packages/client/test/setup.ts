// The hooks run in a browser or in React Native, both of which have a `window`. Without
// one TanStack Query takes the runtime for a server, where queries never poll.
Object.assign(globalThis, { window: globalThis });
