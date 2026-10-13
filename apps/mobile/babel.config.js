// Expo's preset (what Metro uses by default), declared so Jest compiles with it too.
module.exports = (api) => {
  api.cache(true);
  return { presets: ["babel-preset-expo"] };
};
