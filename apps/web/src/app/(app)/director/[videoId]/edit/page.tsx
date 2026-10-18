import { pageTitle } from "@/lib/metadata";
import { EditPage } from "@/modules/director";

export const generateMetadata = pageTitle("director.editor.title");

export default async function Page({
  params,
  searchParams,
}: PageProps<"/director/[videoId]/edit">) {
  const [{ videoId }, query] = await Promise.all([params, searchParams]);
  const audio = Array.isArray(query.audio) ? query.audio[0] : query.audio;
  // Arriving from the last shot: Director calls the wrap and plays its cut.
  return <EditPage videoId={videoId} audio={audio} wrap={query.wrap === "1"} />;
}
