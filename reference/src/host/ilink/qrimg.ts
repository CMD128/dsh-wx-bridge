/**
 * Server-side QR image generation for the binding page.
 *
 * The iLink `qrcode_img_content` is NOT an image: it is a WeChat verification
 * WEBPAGE URL (opening it in a browser shows a QR; putting it in <img src>
 * yields a broken image / cross-origin refusal). The correct display is a QR
 * code ENCODING that URL — WeChat scans it and opens the binding flow. We
 * generate the data-URL locally with the `qrcode` package (no third-party
 * roundtrip, works offline). Cached per URL: the page polls every 2s.
 */
let cache: { url: string; dataUrl: string } | null = null

export async function qrDataUrl(url: string): Promise<string | null> {
  if (cache?.url === url) return cache.dataUrl
  try {
    const mod: any = await import('qrcode')
    const QRCode = mod.default ?? mod
    const dataUrl: string = await QRCode.toDataURL(url, { margin: 1, width: 320 })
    cache = { url, dataUrl }
    return dataUrl
  } catch {
    return null // page falls back to showing the raw link
  }
}
