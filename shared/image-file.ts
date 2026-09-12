export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
// Read raster headers, not a filename/MIME supplied by the caller. SVG is never accepted.
export function rasterInfo(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (start: number, length: number) =>
    String.fromCharCode(...bytes.subarray(start, start + length));
  if (bytes.length >= 24 && ascii(1, 3) === 'PNG' && bytes[0] === 137 && ascii(12, 4) === 'IHDR')
    return { type: 'image/png', ext: 'png', width: view.getUint32(16), height: view.getUint32(20) };
  if (bytes.length >= 30 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    const format = ascii(12, 4);
    if (format === 'VP8X')
      return {
        type: 'image/webp',
        ext: 'webp',
        width: 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16),
        height: 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16),
      };
    if (format === 'VP8 ' && bytes[23] === 157 && bytes[24] === 1 && bytes[25] === 42)
      return {
        type: 'image/webp',
        ext: 'webp',
        width: view.getUint16(26, true) & 0x3fff,
        height: view.getUint16(28, true) & 0x3fff,
      };
    if (format === 'VP8L' && bytes[20] === 47)
      return {
        type: 'image/webp',
        ext: 'webp',
        width: 1 + bytes[21] + ((bytes[22] & 63) << 8),
        height: 1 + (bytes[22] >> 6) + (bytes[23] << 2) + ((bytes[24] & 15) << 10),
      };
  }
  if (bytes[0] === 255 && bytes[1] === 216) {
    let offset = 2;
    while (offset + 4 < bytes.length) {
      if (bytes[offset++] !== 255) break;
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) break;
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if (
        [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
          marker,
        ) &&
        length >= 7
      )
        return {
          type: 'image/jpeg',
          ext: 'jpg',
          width: view.getUint16(offset + 5),
          height: view.getUint16(offset + 3),
        };
      offset += length;
    }
  }
  return null;
}
export async function limitedBytes(response: Response, limit: number) {
  if (Number(response.headers.get('content-length') || 0) > limit) {
    await response.body?.cancel();
    throw new Error('Image or page exceeds size limit');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty image response');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) {
        await reader.cancel();
        throw new Error('Image or page exceeds size limit');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
