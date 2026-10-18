import { pageTitle } from "@/lib/metadata";
import { ReviewPage } from "@/modules/director";

export const generateMetadata = pageTitle("director.review.title");

export default async function Page({
  params,
  searchParams,
}: PageProps<"/director/[videoId]/review">) {
  const [{ videoId }, query] = await Promise.all([params, searchParams]);
  const audio = Array.isArray(query.audio) ? query.audio[0] : query.audio;
  // Arriving from the last shot: Director calls the wrap and plays its cut.
  return <ReviewPage videoId={videoId} audio={audio} wrap={query.wrap === "1"} />;
}
