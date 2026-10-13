# Native flows (Maestro)

What only a real iOS/Android build can check: the session kept in the device's secure
storage across restarts, the system permission prompt and the APNs/FCM token being
registered, and links opened by the OS. Everything else is covered by the web-rendered
end-to-end suite (`bun run test:e2e --app mobile`) and `bun run --cwd apps/mobile test`.

Run them against a development build on a simulator or device, with the stack running
(`bun dev`) and EXPO_PUBLIC_API_URL pointing at it:

```sh
bun run --cwd apps/mobile ios            # or android: builds and installs the app
maestro test apps/mobile/maestro         # every flow
```

The flows create their own users with a unique address; codes are read from Mailpit
(MAILPIT_URL, default http://localhost:58025) by `scripts/code.js`.
