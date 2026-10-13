/** http_ece ships no types; this is the one function the fake push service needs. */
declare module "http_ece" {
  import type { ECDH } from "node:crypto";

  const ece: {
    decrypt(
      body: Buffer,
      options: { version: "aes128gcm"; privateKey: ECDH; authSecret: string },
    ): Buffer;
  };
  export default ece;
}
