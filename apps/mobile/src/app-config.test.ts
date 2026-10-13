// app.config.ts is outside src/ (Expo reads it at build time); its tests are here, where Jest looks.
import appConfig from "../app.config";

const FINGERPRINT = Array.from({ length: 32 }, () => "AB").join(":");
const NAMES = ["EXPO_PUBLIC_API_URL", "APPLE_TEAM_ID", "ANDROID_CERT_FINGERPRINTS"];
const original = Object.fromEntries(NAMES.map((name) => [name, process.env[name]]));

/** The config a build with these variables gets (unlisted ones unset). */
function configFor(variables: Record<string, string>) {
  for (const name of NAMES) {
    delete process.env[name];
  }
  Object.assign(process.env, variables);
  return appConfig({ config: {}, projectRoot: "", staticConfigPath: null, packageJsonPath: null });
}

afterEach(() => {
  for (const [name, value] of Object.entries(original)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});

describe("the app's links and passkeys", () => {
  const site = "https://app.example.com";

  it("belong to the site it talks to, once the site has the app's identifiers", () => {
    const config = configFor({
      EXPO_PUBLIC_API_URL: site,
      APPLE_TEAM_ID: "ABCDE12345",
      ANDROID_CERT_FINGERPRINTS: FINGERPRINT,
    });
    expect(config.ios?.associatedDomains).toEqual([
      "applinks:app.example.com",
      "webcredentials:app.example.com",
    ]);
    expect(config.android?.intentFilters).toEqual([
      {
        action: "VIEW",
        autoVerify: true,
        data: [{ scheme: "https", host: "app.example.com", pathPrefix: "/invitations/" }],
        category: ["BROWSABLE", "DEFAULT"],
      },
    ]);
  });

  it("are claimed per platform, for the identifier that platform's file needs", () => {
    const ios = configFor({ EXPO_PUBLIC_API_URL: site, APPLE_TEAM_ID: "ABCDE12345" });
    expect(ios.ios?.associatedDomains).toHaveLength(2);
    expect(ios.android?.intentFilters).toBeUndefined();
    const android = configFor({
      EXPO_PUBLIC_API_URL: site,
      ANDROID_CERT_FINGERPRINTS: FINGERPRINT,
    });
    expect(android.ios?.associatedDomains).toBeUndefined();
    expect(android.android?.intentFilters).toHaveLength(1);
  });

  it("aren't claimed without the identifiers, whose files the site then doesn't serve", () => {
    const config = configFor({ EXPO_PUBLIC_API_URL: site });
    expect(config.ios?.associatedDomains).toBeUndefined();
    expect(config.android?.intentFilters).toBeUndefined();
  });

  it("aren't claimed for a development site, which iOS and Android can't verify", () => {
    const config = configFor({
      EXPO_PUBLIC_API_URL: "http://192.168.1.10:3000",
      APPLE_TEAM_ID: "ABCDE12345",
      ANDROID_CERT_FINGERPRINTS: FINGERPRINT,
    });
    expect(config.ios?.associatedDomains).toBeUndefined();
    expect(config.android?.intentFilters).toBeUndefined();
  });
});
