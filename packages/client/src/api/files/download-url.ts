/** A short-lived URL to read one of the user's ready files (or anyone's avatar). */
import { useApi } from "../../provider";

/** For code that reads the file once, as it needs it (no caching: the URL expires). */
export function useFileDownloadUrl() {
  const { client } = useApi();
  return (fileId: string) => client.files.downloadUrl({ fileId });
}
