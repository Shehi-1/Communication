const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const sharp = require("sharp");

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

const ALLOWED_AUDIO_MIMES = new Set([
  "audio/wav",
  "audio/webm",
  "audio/ogg",
  "audio/mpeg",
  "audio/mp4"
]);

function validateAudioHeader(buffer, mime) {
  if (!buffer || buffer.length < 4) return false;
  if (mime === "audio/wav") {
    return (
      buffer.length >= 12 &&
      buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
      buffer.subarray(8, 12).toString("ascii") === "WAVE"
    );
  }
  if (mime === "audio/ogg") {
    return buffer.subarray(0, 4).toString("ascii") === "OggS";
  }
  if (mime === "audio/webm") {
    return buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3;
  }
  if (mime === "audio/mpeg") {
    const isId3 = buffer.length >= 3 && buffer.subarray(0, 3).toString("ascii") === "ID3";
    const isSync = (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0);
    return isId3 || isSync;
  }
  if (mime === "audio/mp4") {
    return buffer.length >= 8 && buffer.subarray(4, 8).toString("ascii") === "ftyp";
  }
  return false;
}

async function validateAudio(file) {
  const mime = declaredMime(file);
  if (
    !file?.buffer?.length ||
    !ALLOWED_AUDIO_MIMES.has(mime) ||
    !validateAudioHeader(file.buffer, mime)
  ) {
    throw new MediaValidationError("Voice notes must be valid WAV, WebM, Ogg, MP3, or MP4 audio recordings.");
  }
  try {
    const { parseBuffer } = await import("music-metadata");
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
