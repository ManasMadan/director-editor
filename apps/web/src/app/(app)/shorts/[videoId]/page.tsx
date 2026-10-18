import { permanentRedirect } from "next/navigation";

// The Shorts feed is gone; a link to one of its shorts opens that short in Director.
export default async function Page({ params }: PageProps<"/shorts/[videoId]">) {
  permanentRedirect(`/director/${(await params).videoId}`);
}
