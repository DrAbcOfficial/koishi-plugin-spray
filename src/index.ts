import { Context, Schema, Session, h } from 'koishi'
import sharp from 'sharp'

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

async function generateWad3Spray(imageBuffer: Buffer, maxPixiel: number): Promise<Buffer> {
  // Step 1: 加载并调整图像尺寸
  let img = sharp(imageBuffer)
  const metadata = await img.metadata()
  let { width: fw, height: fh } = metadata

  if (!fw || !fh) 
    throw new Error('Invalid image')

  // 尺寸限制：面积 <= 14336 pixels (e.g., 128x112)
  if (fw * fh > 14336) {
    if (fw > fh) {
      fh = Math.round((fh / fw) * 256)
      fw = 256
    } else {
      fw = Math.round((fw / fh) * 256)
      fh = 256
    }
    while (fw * fh > maxPixiel) {
      fw = Math.round(fw * 0.97)
      fh = Math.round(fh * 0.97)
    }
  }

  // 对齐到 16 的倍数
  const gap = 16
  let w = fw % gap > gap / 2 ? fw + gap - (fw % gap) : fw - (fw % gap)
  let h = fh % gap > gap / 2 ? fh + gap - (fh % gap) : fh - (fh % gap)

  // 量化到 256 色（含透明色）
  const quantized = await sharp(imageBuffer)
    .resize(w, h, { fit: 'fill' })
    .png({ palette: true, quality: 100, colors: 255 }) // 先保留 255 色
    .toBuffer({ resolveWithObject: true })

  // 提取调色板（RGBA）
  const rgbaPalette: { r: number; g: number; b: number; a: number }[] = []
  const pixelData = await sharp(quantized.data).raw().toBuffer()
  const seen = new Set<string>()

  for (let i = 0; i < pixelData.length; i += 4) {
    const r = pixelData[i]
    const g = pixelData[i + 1]
    const b = pixelData[i + 2]
    const a = pixelData[i + 3]
    const key = `${r},${g},${b},${a}`
    if (!seen.has(key)) {
      seen.add(key)
      rgbaPalette.push({ r, g, b, a })
    }
  }

  // 补足到 255 色（黑色填充）
  while (rgbaPalette.length < 255) {
    rgbaPalette.push({ r: 0, g: 0, b: 0, a: 255 })
  }
  // 第 256 色：纯蓝（用于透明）
  rgbaPalette.push({ r: 0, g: 0, b: 255, a: 255 })

  // 构建索引图（每个像素映射到 palette index）
  const indexedPixels: number[] = []
  for (let i = 0; i < pixelData.length; i += 4) {
    const r = pixelData[i]
    const g = pixelData[i + 1]
    const b = pixelData[i + 2]
    const a = pixelData[i + 3]

    if (a <= 128) {
      indexedPixels.push(255) // 透明 → 蓝色索引
    } else {
      // 找最接近的颜色（简化：精确匹配）
      const idx = rgbaPalette.findIndex(c => c.r === r && c.g === g && c.b === b && c.a === a)
      indexedPixels.push(idx >= 0 ? idx : 255)
    }
  }

  // 构建 WAD3 二进制
  const size = w * h
  const mipsSizes = [size, Math.floor(size / 4), Math.floor(size / 16), Math.floor(size / 64)]
  const mipsOffsets = [40, 40 + mipsSizes[0], 40 + mipsSizes[0] + mipsSizes[1], 40 + mipsSizes[0] + mipsSizes[1] + mipsSizes[2]]

  const header = Buffer.alloc(40)
  header.write('WAD3', 0)
  header.writeUInt32LE(1, 4)        // numlumps
  // lump offset 占位（后面回填）
  header.write('{LOGO\0\0\0\0\0\0\0\0\0\0\0', 12)
  header.writeUInt32LE(w, 28)
  header.writeUInt32LE(h, 32)
  header.writeUInt32LE(mipsOffsets[0], 36)
  header.writeUInt32LE(mipsOffsets[1], 40)
  header.writeUInt32LE(mipsOffsets[2], 44)
  header.writeUInt32LE(mipsOffsets[3], 48)

  // Mipmaps（简单下采样：取左上角）
  const mipsData: Buffer[] = []
  for (let level = 0; level < 4; level++) {
    const step = 1 << level
    const buf: number[] = []
    for (let y = 0; y < h; y += step) {
      for (let x = 0; x < w; x += step) {
        const idx = y * w + x
        buf.push(indexedPixels[idx] ?? 255)
      }
    }
    mipsData.push(Buffer.from(buf))
  }

  // Palette (256 * RGB)
  const paletteBuf = Buffer.alloc(256 * 3)
  for (let i = 0; i < 256; i++) {
    const c = rgbaPalette[i] || { r: 0, g: 0, b: 0 }
    paletteBuf.writeUInt8(c.r, i * 3)
    paletteBuf.writeUInt8(c.g, i * 3 + 1)
    paletteBuf.writeUInt8(c.b, i * 3 + 2)
  }

  // 拼接主数据
  let mainData = Buffer.concat([header.slice(0, 52), ...mipsData, Buffer.from([0, 1, 0, 0]), paletteBuf])
  const padMain = requiredPadding(mainData.length, 4)
  if (padMain > 0) mainData = Buffer.concat([mainData, Buffer.alloc(padMain)])

  // Lump directory
  const lumpOffset = mainData.length
  const lump = Buffer.alloc(32)
  lump.writeUInt32LE(12, 0)           // textureoffset
  const sizeOnDisk = mainData.length - 40 // 近似
  lump.writeUInt32LE(sizeOnDisk, 4)
  lump.writeUInt32LE(sizeOnDisk, 8)
  lump.writeUInt8(0x43, 12)           // type 'C'
  lump.writeUInt8(0, 13)              // compression
  lump.writeUInt16LE(0, 14)           // dummy
  lump.write('{LOGO\0\0\0\0\0\0\0\0\0\0\0', 16)

  // 回填 lump offset in header
  const full = Buffer.concat([mainData, lump])
  full.writeUInt32LE(lumpOffset, 8)

  return full
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

  if (!firstImg?.attrs?.src) return null

  const url = firstImg.attrs.src as string

  try {
    // 使用 ctx.http 下载图片（自动处理跨域、重定向等）
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
  ctx.command("喷漆 制作一张喷漆")
  .action(async ({session})=>{
    let image = await getFirstImageAsBuffer(ctx, session);
    if(image == null)
      return '输入一张图片吧';
    const wadBuffer = await generateWad3Spray(image, config.maxPixiel);
    return h.file(wadBuffer)
  });
}
