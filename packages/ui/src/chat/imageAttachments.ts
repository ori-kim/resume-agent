export const MAX_IMAGE_ATTACHMENTS = 4;
export const MAX_IMAGE_ATTACHMENT_BYTES = 5 * 1024 * 1024;

export type ImageAttachmentOptions = {
  existingCount?: number;
  maxFiles?: number;
  maxBytes?: number;
};

export function getAcceptedImageFiles(
  files: Iterable<File>,
  options: ImageAttachmentOptions = {}
): File[] {
  const existingCount = options.existingCount ?? 0;
  const maxFiles = options.maxFiles ?? MAX_IMAGE_ATTACHMENTS;
  const maxBytes = options.maxBytes ?? MAX_IMAGE_ATTACHMENT_BYTES;
  const remaining = Math.max(0, maxFiles - existingCount);

  return Array.from(files)
    .filter((file) => file.type.startsWith("image/") && file.size <= maxBytes)
    .slice(0, remaining);
}

export function imageAttachmentId(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}`;
}
