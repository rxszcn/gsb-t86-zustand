/**
 * 探针：一次 setState 的通知过程中，「新增订阅」与「监听器里再 setState」两类重入下，
 * 裸 subscribe 与 subscribeWithSelector 的 selector 订阅各自的调用次数 / 参数（两本账）。
 *
 * 运行：
 *   cd ~/gsb/seed/zustand && node_modules/.bin/esbuild --bundle --platform=node --format=esm \
 *     --define:import.meta.env='"{}"' --log-level=error \
 *     /mnt/d/Projects/biaozhu/zhongqiang/Pair-wise-GSB/.scratch/dig-zustand/zus-subscribe-during-notify.ts \
 *     --outfile=/tmp/zus-subscribe-during-notify.mjs && node /tmp/zus-subscribe-during-notify.mjs
 */
import { createStore } from '/home/liuyang/gsb/seed/zustand/src/vanilla.ts'
import { subscribeWithSelector } from '/home/liuyang/gsb/seed/zustand/src/middleware/subscribeWithSelector.ts'

type St = { count: number; other: string }

// ---------- 场景 1：通知进行中新增订阅 ----------
console.log('### 场景1: 通知进行中新增订阅（listener 里 subscribe）')
{
  const log: string[] = []
  let added = false
  const store: any = createStore(
    subscribeWithSelector<St>(() => ({ count: 0, other: 'a' })),
  )
  const latePlain = (s: St, p: St) =>
    log.push(`late-plain(state.count=${s.count}, prev.count=${p && p.count})`)
  const lateSel = (s: number, p: number) =>
    log.push(`late-sel(slice=${s}, prevSlice=${p})`)
  store.subscribe((s: St, p: St) => {
    log.push(`L1-plain(state.count=${s.count}, prev.count=${p && p.count})`)
    if (!added) {
      added = true
      store.subscribe(latePlain)
      store.subscribe((st: St) => st.count, lateSel)
      log.push('  >> 在本轮通知进行中新增了 late-plain 与 late-sel')
    }
  })
  store.setState({ count: 1 })
  console.log('第 1 次 setState({count:1}) 的通知日志:')
  log.forEach((l) => console.log('   ' + l))
  log.length = 0
  store.setState({ count: 2 })
  console.log('第 2 次 setState({count:2}) 的通知日志:')
  log.forEach((l) => console.log('   ' + l))
  console.log(
    `=> late-plain 调用次数=${log.filter((l) => l.startsWith('late-plain')).length}(第1轮内) late-sel 第1轮内调用次数=0（见上一段）`,
  )
}

// ---------- 场景 2：监听器里再 setState（重入） ----------
console.log('\n### 场景2: listener 内再 setState（重入通知）')
{
  const log: string[] = []
  let nested = false
  const store: any = createStore(
    subscribeWithSelector<St>(() => ({ count: 0, other: 'a' })),
  )
  const L2plain = (s: St, p: St) =>
    log.push(`L2-plain(state.count=${s.count}, prev.count=${p && p.count})`)
  const L3sel = (s: number, p: number) =>
    log.push(`L3-sel(slice=${s}, prevSlice=${p})`)
  store.subscribe((s: St, p: St) => {
    log.push(`L1-plain(state.count=${s.count}, prev.count=${p && p.count})`)
    if (!nested) {
      nested = true
      log.push('  >> L1 内再 setState({count: state.count+10})')
      store.setState({ count: s.count + 10 })
    }
  })
  store.subscribe(L2plain)
  store.subscribe((st: St) => st.count, L3sel)
  const identitySeen = new Set<number>()
  store.setState({ count: 1 })
  console.log('一次 store.setState({count:1}) 的完整通知日志:')
  log.forEach((l) => console.log('   ' + l))
  console.log(
    `=> L1-plain ${log.filter((l) => l.startsWith('L1-plain')).length} 次, ` +
      `L2-plain ${log.filter((l) => l.startsWith('L2-plain')).length} 次, ` +
      `L3-sel ${log.filter((l) => l.startsWith('L3-sel')).length} 次`,
  )
  console.log(
    '   最终内存 state.count=' + store.getState().count + ' (两次 set 后)',
  )
}

// ---------- 场景 3：空写入 / 同引用写入 ----------
console.log('\n### 场景3: 判据层面（partial 与整个 state 比 / slice 与 slice 比）')
{
  const mk = () =>
    createStore(subscribeWithSelector<St>(() => ({ count: 1, other: 'a' })))
  const runs: [string, (s: any) => void][] = [
    ['set(s => s)          ', (s) => s.setState((x: St) => x)],
    ['set({}) 空对象        ', (s) => s.setState({})],
    ['set({other:"a"})同值  ', (s) => s.setState({ other: 'a' })],
  ]
  for (const [label, act] of runs) {
    const store = mk()
    let plain = 0
    let sel = 0
    const before = store.getState()
    store.subscribe(() => plain++)
    store.subscribe((st: St) => st.count, () => sel++)
    act(store)
    console.log(
      `${label} | 裸订阅调用=${plain} selector订阅调用=${sel} | state引用变化=${before !== store.getState()} | count=${store.getState().count}`,
    )
  }
}
