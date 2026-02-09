import { Context, Schema, Session, h } from 'koishi';
import { PassThrough } from 'stream';
import sharp from 'sharp';

export const name = 'spray'

export interface Config {
  maxPixiel: number
}

export const Config: Schema<Config> = Schema.object({
  maxPixiel: Schema.number().description("最大允许像素，Half-Life、Counter-Strike限制为12288，Sven Co-op限制为14336").min(1).default(12288)
})

function requiredPadding(length: number, multiple: number): number {
  const excess = length % multiple
  return excess === 0 ? 0 : multiple - excess
}

function resizeWithAspectRatioAndAlign(fw, fh, maxPixel = 14336, align = 16) {
  const aspect = fw / fh;

  // Step 1: 计算在保持宽高比下，面积不超过 maxPixel 的最大可能尺寸
  // 设 w = a * k, h = b * k，则 w * h = (a*b) * k^2 <= maxPixel
  // => k <= sqrt(maxPixel / (a*b)) = sqrt(maxPixel / (fw * fh))
  // 所以理想尺寸为:
  const scale = Math.sqrt(maxPixel / (fw * fh));
  let wIdeal = fw * scale;
  let hIdeal = fh * scale;

  // Step 2: 向下对齐到 align 的倍数（保守策略，确保不超限）
  let w = Math.floor(wIdeal / align) * align;
  let h = Math.floor(hIdeal / align) * align;

  // 防止对齐后变成 0
  if (w === 0) w = align;
  if (h === 0) h = align;

  // Step 3: 如果对齐后面积仍略超（理论上不会，但保险起见），微调
  while (w * h > maxPixel) {
    if (w >= h) {
      w -= align;
    } else {
      h -= align;
    }
    if (w <= 0 || h <= 0) 
      break; // 安全兜底
  }

  return { w, h };
}

async function generateWad3Spray(imageBuffer: Buffer, maxPixiel: number): Promise<Buffer> {
  // --- Step 1: 调整尺寸 ---
  const img = sharp(imageBuffer);
  const metadata = await img.metadata();
  const fw = metadata.width!;
  const fh = metadata.height!;
  if (!fw || !fh) throw new Error('Invalid image');

  const { w, h } = resizeWithAspectRatioAndAlign(fw, fh, maxPixiel);
  if (!w || !h) throw new Error('Invalid image size');

  // --- Step 2: 量化到 255 色 + 透明 ---
  const quantized = await sharp(imageBuffer)
    .resize(w, h, { fit: 'fill' })
    .png({ palette: true, quality: 100, colors: 255 })
    .toBuffer({ resolveWithObject: true });

  const pixelData = await sharp(quantized.data).raw().toBuffer();

  // 构建调色板（最多 255 非透明 + 1 透明）
  const rgbaPalette: { r: number; g: number; b: number; a: number }[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < pixelData.length; i += 4) {
    const [r, g, b, a] = [pixelData[i], pixelData[i + 1], pixelData[i + 2], pixelData[i + 3]];
    const key = `${r},${g},${b},${a}`;
    if (!seen.has(key)) {
      seen.add(key);
      rgbaPalette.push({ r, g, b, a });
    }
  }

  while (rgbaPalette.length < 255) {
    rgbaPalette.push({ r: 0, g: 0, b: 0, a: 255 });
  }
  rgbaPalette.push({ r: 0, g: 0, b: 255, a: 255 }); // index 255 = transparent

  // 构建索引像素
  const indexedPixels: number[] = [];
  for (let i = 0; i < pixelData.length; i += 4) {
    const [r, g, b, a] = [pixelData[i], pixelData[i + 1], pixelData[i + 2], pixelData[i + 3]];
    if (a <= 128) {
      indexedPixels.push(255);
    } else {
      const idx = rgbaPalette.findIndex(c => c.r === r && c.g === g && c.b === b && c.a === a);
      indexedPixels.push(idx >= 0 ? idx : 255);
    }
  }

  // --- Step 3: 构建 Mipmaps ---
  const mipsData: Buffer[] = [];
  for (let level = 0; level < 4; level++) {
    const step = 1 << level;
    const buf: number[] = [];
    for (let y = 0; y < h; y += step) {
      for (let x = 0; x < w; x += step) {
        const idx = y * w + x;
        buf.push(indexedPixels[idx] ?? 255);
      }
    }
    mipsData.push(Buffer.from(buf));
  }

  const mipsSizes = mipsData.map(buf => buf.length);
  const totalMipSize = mipsSizes.reduce((a, b) => a + b, 0);

  // --- Step 4: 使用内存流构建 WAD3 ---
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on('data', chunk => chunks.push(chunk as Buffer));
  stream.on('end', () => {}); // just to avoid warnings

  // 写入主 header（前 40 字节，lump offset 稍后回填）
  const header = Buffer.alloc(52); // 实际写 52 字节（含 mip offsets）
  header.write('WAD3', 0);
  header.writeUInt32LE(1, 4); // numlumps
  // offset 占位（8-12 字节），稍后回填
  header.write('{LOGO\0\0\0\0\0\0\0\0\0\0\0', 12); // name
  header.writeUInt32LE(w, 28);
  header.writeUInt32LE(h, 32);
  let offset = 40;
  for (let i = 0; i < 4; i++) {
    header.writeUInt32LE(offset, 36 + i * 4);
    offset += mipsSizes[i];
  }
  stream.write(header);

  // 写入 mip levels
  for (const mip of mipsData) {
    stream.write(mip);
  }

  // 写入 type info + palette
  stream.write(Buffer.from([0, 1, 0, 0])); // type marker

  // Palette: 256 * RGB (ignore alpha)
  const paletteBuf = Buffer.alloc(256 * 3);
  for (let i = 0; i < 256; i++) {
    const c = rgbaPalette[i] || { r: 0, g: 0, b: 0 };
    paletteBuf.writeUInt8(c.r, i * 3);
    paletteBuf.writeUInt8(c.g, i * 3 + 1);
    paletteBuf.writeUInt8(c.b, i * 3 + 2);
  }
  stream.write(paletteBuf);

  // Padding to 4-byte alignment
  const currentLength = 52 + totalMipSize + 4 + 256 * 3;
  const pad = requiredPadding(currentLength, 4);
  if (pad > 0) {
    stream.write(Buffer.alloc(pad));
  }

  // 记录 main data 结束位置（即 lump 目录偏移）
  const mainDataEnd = currentLength + pad;

  // 写入 lump directory (32 bytes)
  const lump = Buffer.alloc(32);
  lump.writeUInt32LE(12, 0);           // textureoffset (相对 lump 起始？但 WAD3 通常指文件内偏移)
  const sizeOnDisk = mainDataEnd - 40; // 主体数据从 40 开始
  lump.writeUInt32LE(sizeOnDisk, 4);   // disksize
  lump.writeUInt32LE(sizeOnDisk, 8);   // filesize
  lump.writeUInt8(0x43, 12);           // type 'C'
  lump.writeUInt8(0, 13);              // compression
  lump.writeUInt16LE(0, 14);           // dummy
  lump.write('{LOGO\0\0\0\0\0\0\0\0\0\0\0', 16); // name

  stream.write(lump);
  stream.end();

  // 等待所有数据写入完成
  await new Promise<void>(resolve => {
    stream.once('finish', resolve);
  });

  // 合并 chunks
  let fullBuffer = Buffer.concat(chunks);

  // 回填 lump offset in global header (at byte 8)
  fullBuffer.writeUInt32LE(mainDataEnd, 8);

  return fullBuffer;
}
/**
 * 从会话中提取第一张图片并返回其 Buffer。
 * @param ctx - Koishi 上下文（用于 HTTP 请求）
 * @param session - 当前会话
 * @returns Promise<Buffer | null>，若无图片则返回 null
 */
async function getFirstImageAsBuffer(ctx: Context, session: Session): Promise<Buffer | null> {
  // 方法 1：从 h 元素解析（推荐）
  const elements = session.elements
  const firstImg = elements.find(el => el.type === 'img' && el.attrs?.src)

  if (!firstImg?.attrs?.src) 
    return null

  const url = firstImg.attrs.src as string;
  return getImageBufferFromUrl(ctx, url);
}

async function getImageBufferFromUrl(ctx: Context, url:string): Promise<Buffer | null>{
  try {
    const arrayBuffer = await ctx.http.get<ArrayBuffer>(url, {
      responseType: 'arraybuffer',
      timeout: 10000,
    })
    return Buffer.from(arrayBuffer)
  } catch (err) {
    ctx.logger.warn('Failed to download image:', url, err)
    return null
  }
}

export function apply(ctx: Context, config: Config) {
  ctx.command("喷漆 [URL]:string 制作一张喷漆")
  .action(async ({session}, url: string)=>{
    let image = null;
    if(url != null)
      image = await getImageBufferFromUrl(ctx, url);
    else
      image = await getFirstImageAsBuffer(ctx, session);
    if(image == null)
      return '输入一张图片吧';
    const wadBuffer = await generateWad3Spray(image, config.maxPixiel);
    return h.file(wadBuffer, 'application/wad3', { filename: `tempdecal-${session.author.id}.wad` });
  });
}
