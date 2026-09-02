/**
 * Login-QR rendering: terminal QR when qrcode-terminal is available, plus an
 * online-render fallback link that always works (scan it with WeChat).
 * The latest QR string is also kept for the optional /wechat/api/status
 * endpoint so a GUI panel can render it later.
 */
let latestQr: string | null = null

export function getLatestQr(): string | null {
  return latestQr
}

export async function renderScanQr(
  qrcode: string,
  logger: { info: (m: string) => void; warn: (m: string) => void },
): Promise<void> {
  latestQr = qrcode
  try {
    const mod: any = await import('qrcode-terminal')
    const qrt = mod.default ?? mod
    qrt.generate(qrcode, { small: true }, (out: string) => {
      // Direct write: the logger may reformat/indent multi-line art.
      process.stderr.write(`\n🤖 dsh-chatops: 用微信扫码登录 Bot（小号！）\n${out}\n`)
    })
  } catch {
    logger.info(
      'dsh-chatops: qrcode-terminal not installed; render the login QR via this link:\n' +
        `  https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qrcode)}`,
    )
  }
}
