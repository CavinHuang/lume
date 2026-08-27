/** Upload media type values matching OpenClaw proto UploadMediaType. */
export type WeixinUploadMediaTypeValue = 1 | 2 | 3 | 4;

/** Result of a successful CDN upload, used to fill media item fields in sendmessage. */
export interface WeixinUploadedMedia {
  filekey: string;
  /** CDN download parameter — fills `encrypt_query_param` in image/video/file items. */
  downloadEncryptedQueryParam: string;
  /** AES-128 key as hex string (32 hex chars = 16 bytes). Convert to base64 for `aes_key` field. */
  aeskey: string;
  /** Plaintext file size in bytes. */
  fileSize: number;
  /** Ciphertext size in bytes (AES-128-ECB with PKCS7 padding). */
  fileSizeCiphertext: number;
}
