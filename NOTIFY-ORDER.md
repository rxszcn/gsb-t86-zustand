# 通知次序现状（一次改状态，谁被叫到、上一次拿到什么）

只描述现状，不改实现。复现：`repro/subscribe-notify.ts`，

```
node_modules/.bin/esbuild --bundle --platform=node --format=esm --define:import.meta.env="{}" --log-level=error repro/subscribe-notify.ts --outfile=/tmp/sn.mjs
node /tmp/sn.mjs
```

## 四套判据各管哪一段

一次 `setState` 在两层代码里依次过四道关，四道关互相不看对方：

1. **整状态引用闸（vanilla 层）**：`src/vanilla.ts:60` 的 `if (!Object.is(nextState, state))`。
   `nextState` 是「合并前那半截」——函数入参就取它的返回值，对象入参就是入参本身——直接跟当前整个 `state` 比引用。
   不相等才继续；相等直接返回，一个监听器都不叫。
2. **合并（vanilla 层）**：`src/vanilla.ts:64` 的 `Object.assign({}, state, nextState)`（对象、非 replace 时）。
   只要过了第 1 道闸，合并结果**恒为新对象引用**，哪怕入参是 `{}` 或所有键都同值。
3. **投递（vanilla 层）**：`src/vanilla.ts:67` 的 `listeners.forEach(...)`，`listeners` 是 `src/vanilla.ts:51` 那个活的 `Set`。
   遍历的是这个 Set 本身：遍历中 `add` 进去的成员本轮就会走到；嵌套 `setState` 会在当前 `forEach` 走到一半时重入又跑一遍完整 `forEach`。
4. **切片闸（middleware 层）**：`src/middleware/subscribeWithSelector.ts:50` 起，带选择器的订阅被包成一个 listener。
   订阅时先算 `currentSlice = selector(api.getState())`（`subscribeWithSelector.ts:49`）；每次被投递到才现算 `nextSlice = selector(state)`（`subscribeWithSelector.ts:51`），
   用 `equalityFn(currentSlice, nextSlice)`（默认 `Object.is`，`subscribeWithSelector.ts:48`）**拿切片比切片**。不相等才真正调用户 listener，并把 `currentSlice` 更新成新切片（`subscribeWithSelector.ts:53-55`）。
   裸订阅（`subscribe(listener)` 一参形式）没有这层包装，`listener = selector`（`subscribeWithSelector.ts:47`），被投递到就必叫。

关键不对称：裸订阅只看第 1 道闸；带选择器的订阅是「第 1 道闸放行 + 第 4 道闸再放行」，而且第 4 道闸用的 `currentSlice` 是**订阅那一刻**算的、只在真正回调后才滚动。

---

## 一、通知进行中新加订阅：本轮响不响、下一轮呢

脚本场景 1 的三段读数，原样照抄：

```
第 1 次 setState({count:1}) 的通知日志:
   L1-plain(state.count=1, prev.count=0)
     >> 在本轮通知进行中新增了 late-plain 与 late-sel
   late-plain(state.count=1, prev.count=0)
第 2 次 setState({count:2}) 的通知日志:
   L1-plain(state.count=2, prev.count=1)
   late-plain(state.count=2, prev.count=1)
   late-sel(slice=2, prevSlice=1)
=> late-plain 调用次数=1(第1轮内) late-sel 第1轮内调用次数=0（见上一段）
```

- **late-plain 本轮就响，响 1 次**：`Set.prototype.forEach` 遍历的是活集合（判据 3）。L1 在本轮回调里 `add(latePlain)` 之后，forEach 还会继续访问到这个新成员，于是 late-plain 本轮就被投递到，拿到的 `(state, prevState)` 是 `({count:1,...}, {count:0,...})`，跟 L1 完全一样。
- **late-sel 本轮不响，下一轮才响**：它也被同一个 forEach 走到了，但第 4 道闸拦下了。`subscribeWithSelector.ts:49` 在订阅那一刻（此时内存 state 已经是 `{count:1}`）算出 `currentSlice = 1`；紧接着 forEach 走到它的包装 listener，现算 `nextSlice = selector(state) = 1`，`Object.is(1, 1)` 为真，不调 lateSel，也不滚动 `currentSlice`。所以第 1 轮读数里只有 late-plain、没有 late-sel。
- **下一轮（setState({count:2})）两条都响**：late-plain 照常被投递；late-sel 的包装现算 `nextSlice = 2`，与仍是订阅时快照的 `currentSlice = 1` 不相等，于是回调 `late-sel(slice=2, prevSlice=1)`——注意它拿到的「上一次」是 **1（订阅那一刻的切片），不是 0**，因为它从来没为 1→1 这次回调过。

裸订阅与带选择器那条不一样的根因就一句：判据 3 对两者一视同仁（都走到），但带选择器的多一道判据 4，且这道闸的基线是「订阅时快照」，不是上一次状态。

## 二、监听器里再改一次状态：为什么同一个人被叫两遍、第二遍的上一次为什么是 0、中间一跳谁看见了

脚本场景 2 的读数，原样照抄：

```
一次 store.setState({count:1}) 的完整通知日志:
   L1-plain(state.count=1, prev.count=0)
     >> L1 内再 setState({count: state.count+10})
   L1-plain(state.count=11, prev.count=1)
   L2-plain(state.count=11, prev.count=1)
   L3-sel(slice=11, prevSlice=0)
   L2-plain(state.count=11, prev.count=0)
=> L1-plain 2 次, L2-plain 2 次, L3-sel 1 次
   最终内存 state.count=11 (两次 set 后)
```

初始订阅顺序：L1、L2、L3(selector 包装)。外层 `setState({count:1})` 捕获 `previousState={count:0}`，state 合并成 `{count:1}`，forEach 按集合顺序开始：

- **L1 被叫两遍**：第一遍是外层 forEach 走到 L1；L1 回调里同步再调一次 `setState({count:11})`，这次 setState 又从头跑一遍完整 `listeners.forEach`（判据 3 允许重入），所以 L1 在 forEach 里被走到第二次（此时 `nested` 已置位，不再嵌套），拿到 `(11, 1)`——这里的 `1` 是内层 setState 自己捕获的 `previousState`（外层合并出来的 `{count:1}`）。内层 forEach 跑完，外层 forEach 继续走 L2、L3。
- **L2 两遍拿到两个不同的上一次**：第一遍（内层 forEach 走到）是 `(11, 1)`，`1` 是内层 setState 的 `previousState`；第二遍（外层 forEach 继续走到）是 `(11, 0)`，`0` 是外层 setState 在 `src/vanilla.ts:62` 早就捕获并闭包住的 `previousState`。外层这一遍投递时 state 已是 11，但它发的 prev 仍是当时拍下的快照 `{count:0}`。
- **L3 只叫一遍、上一次是 0 而不是中间值 1**：L3 的包装在内层 forEach 里被走到时，state 已经是 `{count:11}`（L1 改状态发生在 forEach 走到 L3 之前），现算 `nextSlice = 11`，与订阅时的 `currentSlice = 0` 比较不相等，回调 `(11, 0)` 并把 `currentSlice` 滚到 11；外层 forEach 再走到它时，`Object.is(11, 11)` 相等，跳过。
- **中间那一跳 count=1 为什么没人作为「状态变化」看见**：state 从 0→1 的合并结果（`{count:1}`）从没被任何 listener 当成投递参数。forEach 顺序里 L1 是第一个、L1 内就把 state 改成了 11；轮到 L2、L3 时 `selector(state)` 读到的已经是 11，判据 4 只发生过一次比较，即 `0 vs 11`，`1` 从未作为 `currentSlice` 或 `nextSlice` 进过比较。`{count:1}` 只留下两处痕迹：L1 第一遍日志里的 `state.count=1`，以及内层 setState 捕获后发给 L1/L2 的 `prev.count=1`。裸订阅 L2 第二遍反而拿到更老的 `prev=0`，是外层 setState 的旧快照所致（见上一条），不是它看到了中间跳。

## 三、三次 set 各叫几次，比较双方各是什么形状

脚本场景 3 的读数，原样照抄（初始 state 为 `{count:1, other:'a'}`）：

```
set(s => s)           | 裸订阅调用=0 selector订阅调用=0 | state引用变化=false | count=1
set({}) 空对象        | 裸订阅调用=1 selector订阅调用=0 | state引用变化=true | count=1
set({other:"a"})同值  | 裸订阅调用=1 selector订阅调用=0 | state引用变化=true | count=1
```

| 调用 | 第 1 道闸比较双方（`src/vanilla.ts:60`） | 合并后 state | 裸订阅 | 第 4 道闸比较双方（`subscribeWithSelector.ts:52`） | selector 订阅 |
| --- | --- | --- | --- | --- | --- |
| `setState(x => x)` | 函数返回值（=旧 state 自己这个对象）vs 整个 state；`Object.is` 相等 | 不合并，引用不变 | 0 次（闸 1 直接返回） | 根本没走到（闸 1 没放行） | 0 次 |
| `setState({})` | 入参字面量 `{}` 这个半截对象 vs 整个 state `{count:1,other:'a'}`；引用不相等 | `Object.assign({}, state, {})` → 新对象 `{count:1,other:'a'}` | 1 次 | `selector(新state)=1` vs `currentSlice=1`；`Object.is(1,1)` 相等 | 0 次 |
| `setState({other:'a'})` | 入参 `{other:'a'}` 半截 vs 整个 state；引用不相等（只比引用，不看键值） | 合并出新对象，`count` 仍是 1 | 1 次 | 切片 `1` vs 切片 `1`；相等 | 0 次 |

两处点名：

- **「谁拿合并前那半截跟整个状态比」**：判据 1，`src/vanilla.ts:60`。进比较的 `nextState` 是函数返回值或入参对象本身（合并发生在判据通过之后的 `src/vanilla.ts:64`），比较对象是当前整个 `state`，只比引用。所以 `{}` 和同值键都过闸，`x => x` 不过。
- **「谁拿切片比切片」**：判据 4，`src/middleware/subscribeWithSelector.ts:52`。比较双方是 `selector(api.getState())` 在订阅时（含上次真正回调后）留存的 `currentSlice`，与本次投递时现算的 `selector(state)`；形状是选择器返回的切片（本例是 number `count`），不是整状态，也没有「prevState」入参——包装签名虽收 `(state, prevState)` 但 prevState 被直接忽略（`subscribeWithSelector.ts:50` 只写了 `(state)`）。`equalityFn` 可替换（`subscribeWithSelector.ts:48`）。

## 四、收口：能不能收成一套、收在哪、谁付代价

**结论：不能收成一套；这是两层东西。我选维持现状（两道闸分置两层），让「想要一套语义的调用方付代价」。**

- 两道闸比较的形状不同、所在层不同：闸 1 在 vanilla 层，比的是**合并前半截 vs 整个状态的引用**，职责是决定「这次写入是否产生一次状态变更 + 是否合并出新引用」；闸 4 在 middleware 层，比的是**订阅者自选切片**，且必须支持 `equalityFn`（结构比较、深比较）。vanilla 层没有选择器、没有每个订阅者的私有上次值，结构上无法替 middleware 做切片比较。
- **方案 A：收进 vanilla 一层（删掉 middleware 的切片闸）**。vanilla 必须对每个订阅持有 selector/equalityFn/上次切片，middleware 就失去存在意义，`subscribeWithSelector` 降级成空壳。付代价的是现有订阅测试：
  - `tests/vanilla/subscribe.test.tsx:26`「should not be called when state slice is the same」（`setState({other:'b'})` 期 selector spy 不被调）会红——vanilla 现行语义是整引用变了就叫（`tests/vanilla/subscribe.test.tsx:16`「should be called if new state identity is different」，`setState({...getState()})` 必叫且收到 `(initialState, initialState)`），两例直接冲突，必须二选一改写。
  - 自定义比较器两例 `tests/vanilla/subscribe.test.tsx:51`、`tests/vanilla/subscribe.test.tsx:63`（equalityFn 返回 true/false）和 `fireImmediately` 一例 `tests/vanilla/subscribe.test.tsx:124` 全部要下沉重写；`tests/vanilla/subscribe.test.tsx:93`「should keep consistent behavior with equality check」依赖切片闸跨多次 setState 抑制中间值，语义要在 vanilla 重建。
  - React 绑定侧 `tests/subscribe.test.tsx:31/41/52/62/88` 同样五例要跟着搬。
- **方案 B：收进 middleware 一层（删掉 vanilla 的引用闸，让 middleware 包办）**。不可行：裸 vanilla 订阅（不经 middleware）就没有任何闸，`setState(x => x)` 也会照叫，`tests/vanilla/subscribe.test.tsx:6`「should not be called if new state identity is the same」、`tests/vanilla/basic.test.ts:99`「both NaN should not update」立刻红；而且 middleware 拦截不到 vanilla 内部的合并决策。
- **方案 C（我选的）：维持两套，明确分层契约**。vanilla 保证「引用同则零通知，引用异（对象合并）则至少一次通知 + 每订阅者收到本次 setState 拍下的同一个 prev 快照」；middleware 在其上叠加「切片相等则抑制，prev 是切片维度且只在真正回调后滚动」。付代价的是调用方：要「同值写入零通知」就必须用带选择器（或自定义 `equalityFn`）的订阅，裸订阅对 `setState({})` / 同值键必然被叫（场景 3 的两个 1）；要观察「中间跳」或依赖重入次序，不能只听 selector 订阅——场景 2 里 count=1 对 L3 不可见，只有裸订阅的 prev 快照链能还原。
- 附带一条：判据 3 的「活 Set + 可重入 forEach」是上面不对称的放大器（本轮新订阅是否赶上、中间跳被谁吃掉都由投递位置决定），但它本身不做相等判断，不是第五道闸，也无法并入任何一道——它决定的是**次序**而不是**叫不叫**。当前测试套件没有钉住重入/遍历中订阅的次序断言（现有用例只覆盖静态订阅集合，如 `tests/subscribe.test.tsx:109`「should handle multiple subscribers」、`tests/subscribe.test.tsx:122` 退订一例），所以若将来改投递策略（快照后再遍历），受牵动的现有用例为零，但场景 1、2 的全部读数会变——这是文档化现状之外唯一的低成本改动点，本次不动。
