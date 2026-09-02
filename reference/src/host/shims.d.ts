declare module 'qrcode-terminal' {
  const qrcode: {
    generate(text: string, opts?: { small?: boolean }, cb?: (out: string) => void): void
  }
  export default qrcode
}

declare module 'qrcode' {
  const qrcode: {
    toDataURL(text: string, opts?: { margin?: number; width?: number }): Promise<string>
  }
  export default qrcode
}

declare module 'wechaty' {
  export const WechatyBuilder: {
    build(options: Record<string, unknown>): any
  }
}

declare module 'wechaty-puppet-wechat4u' {
  const puppet: any
  export default puppet
}
