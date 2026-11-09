const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const sharp = require("sharp");
const { parseBuffer } = require("music-metadata");

const IMAGE_TYPES = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpeg"],
  ["image/webp", "webp"]
]);
class MediaValidationError extends Error {}

function declaredMime(file) {
  return typeof file?.mimetype === "string"
    ? file.mimetype.split(";")[0].trim().toLowerCase()
    : "";
}

async function normalizeImage(file, { avatar = false } = {}) {
  const inputMime = declaredMime(file);
  if (!file?.buffer?.length || !IMAGE_TYPES.has(inputMime)) {
    throw new MediaValidationError("Choose a PNG, JPEG, or WebP image.");
  }

  try {
    const image = sharp(file.buffer, {
      failOn: "error",
      limitInputPixels: 20_000_000,
      animated: false
    });
    const metadata = await image.metadata();
    if (
      !IMAGE_TYPES.has(inputMime) ||
      metadata.format !== IMAGE_TYPES.get(inputMime) ||
      !metadata.width ||
      !metadata.height ||
      metadata.width * metadata.height > 20_000_000 ||
      (metadata.pages || 1) > 1
    ) {
      throw new MediaValidationError("The uploaded file is not a supported still image.");
    }

    const output = avatar
      ? image.rotate().resize(512, 512, { fit: "cover" })
      : image.rotate().resize(1600, 1600, { fit: "inside", withoutEnlargement: true });
    return { buffer: await output.webp({ quality: 82 }).toBuffer(), mime: "image/webp" };
  } catch (error) {
    if (error instanceof MediaValidationError) throw error;
    throw new MediaValidationError("The uploaded image could not be decoded.");
  }
}

async function validateAudio(file) {
  const mime = declaredMime(file);
  if (
    !file?.buffer?.length ||
    mime !== "audio/wav" ||
    file.buffer.subarray(0, 4).toString("ascii") !== "RIFF" ||
    file.buffer.subarray(8, 12).toString("ascii") !== "WAVE"
  ) {
    throw new MediaValidationError("Voice notes must be valid WAV audio recordings.");
  }
  try {
    const metadata = await parseBuffer(file.buffer, {
      mimeType: mime,
      size: file.buffer.length
    });
    const duration = metadata.format.duration;
    if (
      metadata.format.hasAudio !== true ||
      metadata.format.hasVideo === true ||
      !Number.isFinite(duration) ||
      duration <= 0 ||
      duration > 120
    ) {
      throw new MediaValidationError("Voice notes must contain audio and be no longer than 2 minutes.");
    }
    return { buffer: file.buffer, mime, duration };
  } catch (error) {
    if (error instanceof MediaValidationError) throw error;
    throw new MediaValidationError("The voice note could not be decoded.");
  }
}

async function storeMedia(mediaDir, buffer, extension) {
  await fs.mkdir(mediaDir, { recursive: true, mode: 0o700 });
  const key = `${crypto.randomUUID()}.${extension}`;
  await fs.writeFile(path.join(mediaDir, key), buffer, { flag: "wx", mode: 0o600 });
  return key;
}

function mediaPath(mediaDir, key) {
  if (
    typeof key !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(webp|webm|ogg|wav|mp3|m4a)$/.test(key)
  ) {
    throw new Error("Stored media key is invalid.");
  }
  return path.join(mediaDir, key);
}

async function removeMedia(mediaDir, key) {
  if (!key) return;
  await fs.rm(mediaPath(mediaDir, key), { force: true });
}

module.exports = {
  MediaValidationError,
  normalizeImage,
  validateAudio,
  storeMedia,
  mediaPath,
  removeMedia
};
