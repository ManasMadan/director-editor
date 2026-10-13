import { pageTitle } from "@/lib/metadata";
import { ReviewPage } from "@/modules/director";

export const generateMetadata = pageTitle("director.review.title");

export default async function Page({
  params,
  searchParams,
}: PageProps<"/director/[videoId]/review">) {
  const [{ videoId }, query] = await Promise.all([params, searchParams]);
  const audio = Array.isArray(query.audio) ? query.audio[0] : query.audio;
  return <ReviewPage videoId={videoId} audio={audio} />;
}
