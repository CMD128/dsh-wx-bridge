/**
 * dsh-wx-bridge client half: a settings-page tab「微信通道」(settings.section
 * slot — the DSH-idiomatic extension point for plugin settings).
 *
 * 连接状态 + 扫码绑定 + 授权码/推送/默认会话配置。数据经 host loopback API
 * (/chatops/api/*)；保存写 profile override 行，cordis 热重载。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'

export const name = 'dsh-wx-bridge'
export const inject = ['slots']

const STATE_LABELS = {
  idle: '未启用', await_scan: '等待扫码', scanned: '已扫码待确认', need_verifycode: '需要验证码',
  connecting: '连接中…', connected: '已连接', error: '出错',
}

const styles = {
  wrap: { padding: '16px 20px', maxWidth: 760, fontFamily: 'inherit', color: 'var(--dsw-alias-label-primary, #1b1b1c)' },
  card: { border: '1px solid var(--dsw-alias-border-l2, #e2e4e9)', borderRadius: 10, padding: '14px 16px', marginBottom: 14, background: 'var(--dsw-alias-bg-layer-2, #fff)' },
  head: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 },
  title: { fontWeight: 600, fontSize: 15, color: 'var(--dsw-alias-label-primary, #1b1b1c)' },
  desc: { color: 'var(--dsw-alias-label-tertiary, #888)', fontSize: 12.5, marginBottom: 10 },
  dot: (color) => ({ width: 9, height: 9, borderRadius: 9, background: color, flexShrink: 0 }),
  state: { fontSize: 12.5, color: 'var(--dsw-alias-label-tertiary, #888)' },
  row: { display: 'flex', gap: 10, marginBottom: 8, alignItems: 'center' },
  field: { flex: 1, display: 'flex', flexDirection: 'column', gap: 4 },
  label: { fontSize: 12, color: 'var(--dsw-alias-label-caption, #999)' },
  input: { padding: '7px 10px', fontSize: 13, borderRadius: 7, border: '1px solid var(--dsw-alias-border-l3, #ddd)', background: 'var(--dsw-specific-input-major, #fff)', color: 'var(--dsw-alias-label-primary, #1b1b1c)' },
  btn: { padding: '7px 16px', fontSize: 13, borderRadius: 7, border: '1px solid var(--dsw-alias-border-l3, #ddd)', background: 'var(--dsw-alias-button-elevated-fill, #fff)', cursor: 'pointer', color: 'var(--dsw-alias-label-primary, #1b1b1c)' },
  btnPrimary: { padding: '7px 16px', fontSize: 13, borderRadius: 7, border: 'none', background: 'var(--dsw-alias-button-info-fill, #4176e6)', color: '#fff', cursor: 'pointer' },
  btnDanger: { padding: '7px 16px', fontSize: 13, borderRadius: 7, border: 'none', background: '#e6432d', color: '#fff', cursor: 'pointer' },
  qr: { width: 200, borderRadius: 8, border: '1px solid var(--dsw-alias-border-l2, #eee)', display: 'block', margin: '10px 0', background: '#fff' },
  toast: { position: 'fixed', bottom: 24, right: 24, background: 'var(--dsw-alias-toast-bg, #222)', color: '#fff', padding: '10px 16px', borderRadius: 8, fontSize: 13, zIndex: 9999 },
  err: { color: 'var(--dsw-alias-state-error-primary, #e6432d)', fontSize: 12.5, marginTop: 6, wordBreak: 'break-all' },
  hint: { fontSize: 12, color: 'var(--dsw-alias-label-caption, #999)', marginTop: 10 },
  check: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--dsw-alias-label-secondary, #555)' },
}

function stateColor(state, online) {
  if (online || state === 'connected') return '#07c160'
  if (state === 'error') return '#e6432d'
  if (state === 'idle') return '#bbb'
  return '#fa9d3b'
}

function WechatSettings() {
  const [config, setConfig] = useState(null)
  const [status, setStatus] = useState(null)
  const [sessions, setSessions] = useState(null)
  const [toast, setToast] = useState('')
  const toastTimer = useRef(null)

  const showToast = useCallback((text) => {
    setToast(text)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(''), 2600)
  }, [])

  const refresh = useCallback(async () => {
    try {
      const [cfg, st, ss] = await Promise.all([
        fetch('/chatops/api/config').then((r) => r.json()),
        fetch('/chatops/api/status').then((r) => r.json()),
        fetch('/chatops/api/sessions').then((r) => r.json()),
      ])
      if (cfg?.ok) setConfig((prev) => (prev && prev.__dirty ? prev : { ...cfg.result, __dirty: false }))
      if (st?.ok) setStatus(st.result)
      if (ss?.ok) setSessions(ss.result.sessions)
    } catch {
      /* host not ready yet */
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => { void refresh() }, 3000)
    return () => clearInterval(timer)
  }, [refresh])

  const edit = (path, value) => {
    setConfig((prev) => {
      const next = structuredClone(prev)
      let node = next
      for (const key of path.slice(0, -1)) node = node[key] ??= {}
      node[path[path.length - 1]] = value
      next.__dirty = true
      return next
    })
  }

  const save = async () => {
    if (!config) return
    // 授权码校验：启用时必须填 4-6 位数字
    if (config.approval?.enabled) {
      const code = String(config.approval?.authCode ?? '')
      if (!/^\d{4,6}$/.test(code)) {
        showToast('❌ 启用授权码须填写 4-6 位数字')
        return
      }
    }
    const { __dirty, ...clean } = config
    const response = await fetch('/chatops/api/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ config: clean }),
    })
    if (response.ok) {
      setConfig({ ...clean, __dirty: false })
      showToast('✅ 已保存，插件热重载中（若通道未变化请重启 dsh web）')
    } else {
      showToast('❌ 保存失败')
    }
  }

  const rebind = async () => {
    await fetch('/chatops/api/rebind', { method: 'POST' })
    showToast('已解绑，正在生成新二维码…')
    setTimeout(() => void refresh(), 1500)
  }

  if (!config) return React.createElement('div', { style: styles.wrap }, '加载中…')

  const st = status ?? {}
  const s = st.state ?? 'idle'
  const online = Boolean(st.online)
  const authCodeOn = Boolean(config.approval?.enabled)

  return React.createElement('div', { style: styles.wrap },
    React.createElement('h3', { style: { margin: '0 0 4px' } }, '微信通道'),
    React.createElement('div', { style: { ...styles.desc, marginBottom: 14 } },
      '微信官方 ClawBot（iLink）：扫码绑定后，私聊即可驱动 DSH 会话。凭据仅保存在本机。'),

    // 连接状态卡
    React.createElement('div', { style: styles.card },
      React.createElement('div', { style: styles.head },
        React.createElement('span', { style: styles.dot(stateColor(s, online)) }),
        React.createElement('span', { style: styles.title }, '连接状态'),
        React.createElement('span', { style: { ...styles.state, marginLeft: 'auto' } }, STATE_LABELS[s] ?? s),
      ),
      st.ownerUserId
        ? React.createElement('div', { style: styles.desc }, `已绑定账号：${st.ownerUserId}`)
        : React.createElement('div', { style: styles.desc }, '尚未绑定微信账号'),
      s === 'await_scan' && st.qrDataUrl
        ? React.createElement('img', { src: st.qrDataUrl, style: styles.qr, alt: '微信扫码绑定' })
        : null,
      React.createElement('div', { style: styles.row },
        React.createElement('button', { style: styles.btnDanger, onClick: () => void rebind() }, '解绑并重新扫码'),
      ),
    ),

    // 授权码卡
    React.createElement('div', { style: styles.card },
      React.createElement('div', { style: styles.head },
        React.createElement('span', { style: styles.title }, '危险操作授权码'),
      ),
      React.createElement('div', { style: styles.desc },
        '开启后，微信里的危险操作审批需回复授权码才放行（防误操作）。关闭 = 直接 /approve 即可。'),
      React.createElement('div', { style: styles.row },
        React.createElement('label', { style: styles.check },
          React.createElement('input', {
            type: 'checkbox',
            checked: authCodeOn,
            onChange: (e) => edit(['approval', 'enabled'], e.target.checked),
          }),
          '启用授权码'),
        authCodeOn
          ? React.createElement('input', { style: { ...styles.input, width: 140 }, value: String(config.approval?.authCode ?? ''), onChange: (e) => edit(['approval', 'authCode'], e.target.value.replace(/\D/g, '').slice(0, 6)), placeholder: '4-6 位数字', maxLength: 6 })
          : null,
      ),
      React.createElement('div', { style: styles.row },
        React.createElement('label', { style: styles.check },
          React.createElement('input', { type: 'checkbox', checked: config.push?.onSessionComplete !== false, onChange: (e) => edit(['push', 'onSessionComplete'], e.target.checked) }),
          '任务完成推送'),
      ),
    ),

    // 默认会话卡
    React.createElement('div', { style: styles.card },
      React.createElement('div', { style: styles.head },
        React.createElement('span', { style: styles.title }, '默认对接会话'),
      ),
      React.createElement('div', { style: styles.desc },
        '微信未用 /use 指定会话时，消息自动发往此会话（留空 = 最近活跃会话）。'),
      React.createElement('div', { style: styles.row },
        React.createElement('select', {
          style: { ...styles.input, flex: 1 },
          value: config.defaultSessionId ?? '',
          onChange: (e) => edit(['defaultSessionId'], e.target.value || ''),
        },
          React.createElement('option', { value: '' }, '（自动：最近活跃会话）'),
          (sessions ?? []).map((s) =>
            React.createElement('option', { key: s.id, value: s.id }, `${s.live ? '●' : '○'} ${s.title}`)),
        ),
      ),
    ),

    // 保存
    React.createElement('div', { style: styles.row },
      React.createElement('button', { style: config.__dirty ? styles.btnPrimary : styles.btn, onClick: () => void save() },
        config.__dirty ? '保存（有改动）' : '保存'),
    ),
    toast ? React.createElement('div', { style: styles.toast }, toast) : null,
  )
}

function apply(ctx) {
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'dsh-wx-bridge',
    order: 22,
    label: () => '微信通道',
  }, WechatSettings))
}

export { apply }