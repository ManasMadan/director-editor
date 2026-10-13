import { pageTitle } from "@/lib/metadata";
import { ShootPage } from "@/modules/director";

export const generateMetadata = pageTitle("director.title");

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

export default async function Page({
  params,
  searchParams,
}: PageProps<"/director/[videoId]/shoot">) {
  const [{ videoId }, query] = await Promise.all([params, searchParams]);
  return <ShootPage videoId={videoId} shot={first(query.shot)} audio={first(query.audio)} />;
}
