/** Loads config.ts afresh, after `setup` has put its dependencies in place. */
function load(setup?: () => void) {
  let config: typeof import("./config") | undefined;
  jest.isolateModules(() => {
    setup?.();
    config = require("./config");
  });
  return config as typeof import("./config");
}

describe("the API URL", () => {
  const original = process.env.EXPO_PUBLIC_API_URL;
  afterEach(() => {
    process.env.EXPO_PUBLIC_API_URL = original;
    Reflect.deleteProperty(window, "location");
  });

  it("comes from EXPO_PUBLIC_API_URL on a device, without a trailing slash", () => {
    process.env.EXPO_PUBLIC_API_URL = "https://app.example.com/";
    expect(load().apiUrl).toBe("https://app.example.com");
  });

  it("is required on a device, with a message saying what to set", () => {
    delete process.env.EXPO_PUBLIC_API_URL;
    expect(() => load()).toThrow(/EXPO_PUBLIC_API_URL must be the site's URL/);
  });

  it("is the page's own origin on the web", () => {
    delete process.env.EXPO_PUBLIC_API_URL;
    const config = load(() => {
      jest.replaceProperty(require("react-native").Platform, "OS", "web");
      Object.defineProperty(window, "location", {
        value: { origin: "https://app.example.com" },
        configurable: true,
      });
    });
    expect(config.apiUrl).toBe("https://app.example.com");
  });
});

describe("the app version", () => {
  it("is the installed build's", () => {
    const config = load(() => {
      jest.doMock("expo-application", () => ({ nativeApplicationVersion: "1.4.0" }));
    });
    expect(config.appVersion).toBe("1.4.0");
  });

  it("is the app config's without a native build (the web)", () => {
    const config = load(() => {
      jest.doMock("expo-application", () => ({ nativeApplicationVersion: null }));
    });
    expect(config.appVersion).toBe("0.1.0");
  });

  it("is 0.0.0 when nothing says", () => {
    const config = load(() => {
      jest.doMock("expo-application", () => ({ nativeApplicationVersion: null }));
      jest.doMock("expo-constants", () => ({ __esModule: true, default: { expoConfig: null } }));
    });
    expect(config.appVersion).toBe("0.0.0");
  });
});
