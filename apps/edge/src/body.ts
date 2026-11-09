/** Read a web stream into memory, aborting as soon as the byte cap is crossed. */
export async function readBytesBounded(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  declaredBytes?: number,
): Promise<Uint8Array<ArrayBuffer>> {
  if (declaredBytes != null && Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
    throw new Error(`body too large: ${declaredBytes} bytes (cap ${maxBytes})`);
  }
  if (!stream) return new Uint8Array(0);

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`body too large: exceeded ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export async function readTextBounded(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  declaredBytes?: number,
): Promise<string> {
  const bytes = await readBytesBounded(stream, maxBytes, declaredBytes);
  return new TextDecoder().decode(bytes);
}
