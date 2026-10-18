/**
 * Publishes a cut to the member's YouTube channel. PUBLISH_NEEDS_YOUTUBE means their
 * Google account hasn't allowed uploads yet: the app asks for that (better-auth's
 * linkSocial with YOUTUBE_UPLOAD_SCOPE) and tries again. The cut's lists are refreshed
 * either way, since a failed upload is recorded on the cut too.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useApi } from "../../provider";

/** What Director asks Google for, to upload to a member's YouTube channel. */
export const YOUTUBE_UPLOAD_SCOPE = "https://www.googleapis.com/auth/youtube.upload";

export function usePublishMutation() {
  const { api } = useApi();
  const queryClient = useQueryClient();
  return useMutation(
    api.publish.upload.mutationOptions({
      onSettled: async () => {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: api.director.media.key() }),
          queryClient.invalidateQueries({ queryKey: api.director.cuts.key() }),
        ]);
      },
    }),
  );
}
