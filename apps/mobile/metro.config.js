/**
 * Metro (the bundler). Expo detects the monorepo by itself, so workspace packages
 * (TypeScript source) resolve like app code. Uniwind compiles global.css into styles.
 */
const { getDefaultConfig } = require("expo/metro-config");
const { withUniwindConfig } = require("uniwind/metro");

const config = getDefaultConfig(__dirname);

// Uniwind's InputAccessoryView wrapper imports a component react-native-web doesn't
// export under that path; point it at react-native-web's own on web.
const resolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (platform === "web" && moduleName === "uniwind/components/InputAccessoryView") {
    return context.resolveRequest(
      context,
      "react-native-web/dist/exports/InputAccessoryView",
      platform,
    );
  }
  return (resolveRequest ?? context.resolveRequest)(context, moduleName, platform);
};

module.exports = withUniwindConfig(config, {
  cssEntryFile: "./global.css",
  dtsFile: "./uniwind-types.d.ts",
});
