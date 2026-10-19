import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Director",
    short_name: "Director",
    start_url: "/library",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#0a0a0a",
    // The header's red dot on the studio's dark (src/app/icon.svg, drawn larger). The
    // maskable one fills its square, for launchers that cut their own shape.
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
