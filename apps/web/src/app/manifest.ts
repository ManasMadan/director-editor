import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Director",
    short_name: "Director",
    start_url: "/library",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#0a0a0a",
  };
}
