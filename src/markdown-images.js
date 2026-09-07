const fs = require("node:fs");
const path = require("node:path");

// Data URLs keep the reader self-contained: the local web server never needs
// to expose arbitrary project files as HTTP assets. SVG is deliberately not
// included because it is an active-document format rather than a raster image.
const IMAGE_MIME_TYPES = new Map([
  [".avif", "image/avif"],
  [".gif", "image/gif"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"]
]);
const MAX_EMBEDDED_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_EMBEDDED_IMAGES = 12;
const MAX_EMBEDDED_IMAGE_TOTAL_BYTES = 8 * 1024 * 1024;

function isWithinDirectory(directory, candidate) {
  const relative = path.relative(directory, candidate);
  return relative && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
}

function localMarkdownImagePath(sourcePath, target) {
  const value = String(target || "").trim();
  if (!value || /[\u0000-\u001f\u007f]/.test(value)) return null;
  // Only local, relative references are embedded. Remote, absolute and data
  // URLs remain source text and are never fetched or re-written by import.
  if (/^(?:[a-z][a-z0-9+.-]*:|[\\/])/i.test(value) || /^[A-Za-z]:[\\/]/.test(value)) return null;
  const withoutFragment = value.replace(/[?#][\s\S]*$/, "");
  if (!withoutFragment) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(withoutFragment);
  } catch {
    return null;
  }
  const sourceDirectory = path.dirname(path.resolve(sourcePath));
  const candidate = path.resolve(sourceDirectory, decoded.replace(/\//g, path.sep));
  if (!isWithinDirectory(sourceDirectory, candidate)) return null;
  try {
    const realDirectory = fs.realpathSync(sourceDirectory);
    const realCandidate = fs.realpathSync(candidate);
    if (!isWithinDirectory(realDirectory, realCandidate)) return null;
    return realCandidate;
  } catch {
    return null;
  }
}

function embeddedImage(sourcePath, target) {
  const imagePath = localMarkdownImagePath(sourcePath, target);
  if (!imagePath) return null;
  const mimeType = IMAGE_MIME_TYPES.get(path.extname(imagePath).toLowerCase());
  if (!mimeType) return null;
  try {
    const stat = fs.statSync(imagePath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_EMBEDDED_IMAGE_BYTES) return null;
    const bytes = fs.readFileSync(imagePath);
    if (bytes.length !== stat.size || bytes.length > MAX_EMBEDDED_IMAGE_BYTES) return null;
    return { bytes: bytes.length, uri: "data:" + mimeType + ";base64," + bytes.toString("base64") };
  } catch {
    return null;
  }
}

// Supports the portable Markdown forms ![alt](path.png) and
// ![alt](<path with spaces.png>). Leave unsupported references untouched so the
// imported source remains faithful and can still be read as ordinary Markdown.
function embedMarkdownImages(body, sourcePath) {
  let count = 0;
  let totalBytes = 0;
  return String(body == null ? "" : body).replace(/!\[([^\]\r\n]*)\]\(\s*(?:<([^>\r\n]+)>|([^\s)]+))\s*\)/g, (match, alt, bracketedTarget, plainTarget) => {
    if (count >= MAX_EMBEDDED_IMAGES) return match;
    const image = embeddedImage(sourcePath, bracketedTarget || plainTarget);
    if (!image || totalBytes + image.bytes > MAX_EMBEDDED_IMAGE_TOTAL_BYTES) return match;
    count += 1;
    totalBytes += image.bytes;
    return "![" + alt + "](" + image.uri + ")";
  });
}

module.exports = {
  IMAGE_MIME_TYPES,
  MAX_EMBEDDED_IMAGE_BYTES,
  MAX_EMBEDDED_IMAGES,
  MAX_EMBEDDED_IMAGE_TOTAL_BYTES,
  embedMarkdownImages
};
