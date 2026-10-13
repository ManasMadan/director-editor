import { describe, expect, it } from "vitest";
import { appleAppSiteAssociation, assetLinks, mobileApp } from "./app-links";

const FINGERPRINT = Array.from({ length: 32 }, () => "AB").join(":");
const app = {
  APPLE_TEAM_ID: "ABCDE12345",
  IOS_BUNDLE_ID: "com.boilerplate.app",
  ANDROID_PACKAGE: "com.boilerplate.app",
  ANDROID_CERT_FINGERPRINTS: [FINGERPRINT],
};
const none = {
  APPLE_TEAM_ID: undefined,
  IOS_BUNDLE_ID: undefined,
  ANDROID_PACKAGE: undefined,
  ANDROID_CERT_FINGERPRINTS: undefined,
};

describe("the mobile app's association files", () => {
  it("name the app on iOS, for its links and its passkeys", async () => {
    const response = appleAppSiteAssociation(app);
    // Apple reads the extensionless file only as JSON.
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual({
      applinks: {
        details: [
          { appIDs: ["ABCDE12345.com.boilerplate.app"], components: [{ "/": "/invitations/*" }] },
        ],
      },
      webcredentials: { apps: ["ABCDE12345.com.boilerplate.app"] },
    });
  });

  it("name the app and its signing certificates on Android, for links and passkeys", async () => {
    expect(await assetLinks(app).json()).toEqual([
      {
        relation: [
          "delegate_permission/common.handle_all_urls",
          "delegate_permission/common.get_login_creds",
        ],
        target: {
          namespace: "android_app",
          package_name: "com.boilerplate.app",
          sha256_cert_fingerprints: [FINGERPRINT],
        },
      },
    ]);
  });

  it("aren't served while the feature is off (none of its variables set)", () => {
    expect(mobileApp(none)).toBeUndefined();
    expect(appleAppSiteAssociation(none).status).toBe(404);
    expect(assetLinks(none).status).toBe(404);
    // This environment (.env.example) has no app.
    expect(appleAppSiteAssociation().status).toBe(404);
  });

  it("stop a half-configured site, naming what's missing", () => {
    expect(() => mobileApp({ ...app, APPLE_TEAM_ID: undefined })).toThrow(
      "need all four of APPLE_TEAM_ID, IOS_BUNDLE_ID, ANDROID_PACKAGE and " +
        "ANDROID_CERT_FINGERPRINTS set, or none; missing: APPLE_TEAM_ID",
    );
    expect(() =>
      mobileApp({
        ...none,
        IOS_BUNDLE_ID: "com.boilerplate.app",
        ANDROID_PACKAGE: "com.boilerplate.app",
      }),
    ).toThrow("missing: APPLE_TEAM_ID, ANDROID_CERT_FINGERPRINTS");
  });
});
