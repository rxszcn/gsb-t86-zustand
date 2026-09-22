# 通知顺序与四套判据现状（只读分析，不改实现）

复现脚本：`repro/subscribe-notify.ts`

```sh
node_modules/.bin/esbuild --bundle --platform=node --format=esm \
  --define:import.meta.env="{}" --log-level=error \
  repro/subscribe-notify.ts --outfile=/tmp/sn.mjs
node /tmp/sn.mjs
```

涉及代码（本文件只引用，不改动）：

- 裸状态存储：`src/vanilla.ts:73`（`Object.is(nextState, state)` 入口闸门）、`src/vanilla.ts:78`（`Object.assign({}, state, nextState)` 合并）、`src/vanilla.ts:79`（`listeners.forEach(...)` 派发）、`src/vanilla.ts:89`（`listeners.add`）。
- 选择器中间件：`src/middleware/subscribeWithSelector.ts:55`（订阅时快照 `currentSlice`）、`subscribeWithSelector.ts:58`（`!equalityFn(currentSlice, nextSlice)` 切片闸门）、`subscribeWithSelector.ts:60`（快照推进后再回调）。

四套判据先点名，后文逐个引用：

- **判据 A（派发结构）**：`listeners` 是一个 `Set`，`setState` 用一次同步 `forEach` 把当前 `state` 与本次捕获的 `previousState` 原样发给每个成员（`src/vanilla.ts:79`）；通知进行中对 `Set` 的增删会被这一趟 `forEach` 当场看到，没有快照、没有重入队列。
- **判据 B（入口短路）**：`setState` 先算 `nextState`，只有 `!Object.is(nextState, state)` 才继续（`src/vanilla.ts:73`）。注意比较双方是**上游传进来的合并前半截 `nextState`（函数式更新则是其返回值）与整个当前 `state`**；合并发生在比较之后（`src/vanilla.ts:78`）。
- **判据 C（合并形状）**：非 replace 且 `nextState` 是非 null 对象时，一律 `Object.assign({}, state, nextState)`（`src/vanilla.ts:78`），永远造一个新对象；即使 `nextState` 是 `{}` 或只含同值键，state 引用也必变。
- **判据 D（切片闸门）**：带选择器的订阅在**订阅那一刻**就用 `selector(api.getState())` 算好 `currentSlice`（`subscribeWithSelector.ts:55`）；每次通知拿 `selector(state)` 的新切片与缓存的旧切片比，`Object.is` 或自定义 `equalityFn` 相同就不响，不同才把旧切片作为 `previousSlice` 回调并推进缓存（`subscribeWithSelector.ts:58`、`subscribeWithSelector.ts:60`）。比较双方是**切片比切片**。

裸订阅身上只经过 A/B/C（它本身没有任何相等性判断，进了 `forEach` 就一定被叫）；带选择器的订阅在 A/B/C 之后还多一道 D。

---

## 一、通知进行中新加的订阅：本轮响不响、下一轮呢

脚本第 1 段的完整读数（第 1 次 `setState({count:1})` 后 log 被清空，第 2 次是新一轮）：

```
### 场景1: 通知进行中新增订阅（listener 里 subscribe）
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

**本轮（count 0→1 这一趟）**：

- `late-plain` **本轮响，且只响 1 次**：`late-plain(state.count=1, prev.count=0)`。L1 在 `forEach` 迭代途中执行 `store.subscribe(latePlain)`，`listeners.add`（`src/vanilla.ts:89`）直接改了正在被遍历的同一个 `Set`。按判据 A，Set 迭代器会在同一趟 `forEach` 里继续访问到新成员，且派发参数是本轮统一捕获的 `(state=1, previousState=0)`，所以它这一轮就被叫到，拿到的上一次是 `0`。
- `late-sel` **本轮不响（0 次）**：它在 L1 内通过 `store.subscribe(selector, listener)` 加入。按判据 D，订阅动作执行时 `api.getState()` **已经是合并后的 `{count:1,...}`**（合并在 `forEach` 之前，`src/vanilla.ts:78`→`:79`），于是 `subscribeWithSelector.ts:55` 当场算出的缓存切片 `currentSlice = 1`。同一趟 `forEach` 稍后轮到它的包装 listener 时，`selector(state)` 仍是 `1`，`Object.is(1,1)` 为真，`subscribeWithSelector.ts:58` 这道闸门直接挡住。

**为什么裸订阅与带选择器的不一样**：裸订阅没有自己的判据，A 让它"进 Set 就被这一趟 forEach 访问到"，于是本轮必响；选择器订阅虽然同样被 A 在本轮访问到，但访问到的只是中间件的包装函数，它还要过 D，而 D 的基线是"订阅瞬间的切片 1"，本轮切片没有变化，所以被静音。两条订阅都在本轮被加进同一个 `Set`、都在本轮被 `forEach` 访问，差别只在 D 这一道额外闸门，不在派发结构。

**下一轮（count 1→2）**：两条都成为 `Set` 的正常老成员。读数为 `late-plain(state.count=2, prev.count=1)` 与 `late-sel(slice=2, prevSlice=1)` 各 1 次。`late-sel` 的旧切片缓存是上一轮订阅时拍下的 `1`，新切片是 `2`，D 放行，回调的"上一次"正是快照里的 `1`，而不是 store 的初始值 `0`——它永远没机会报告 `1` 这个值的到来。

---

## 二、监听器里再 setState：为什么同一个人被叫两遍、第二遍上一次是 0

脚本第 2 段的完整读数：

```
### 场景2: listener 内再 setState（重入通知）
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

订阅顺序是 L1（内部嵌套 set）、L2（裸订阅 `L2plain`）、L3（选择器 `st.count`），初始 `count=0`。

外层 `setState({count:1})`：判据 B 通过（`{count:1}` 与整个 state 不同引用），判据 C 合并出 state₁(count=1)，捕获 `previousState = state₀(count=0)`，然后开始外层 `forEach`（判据 A）。

1. 外层 forEach 第 1 个成员 L1：收到 `(1,0)` → 日志 `L1-plain(state.count=1, prev.count=0)`；随即**在遍历中途同步**调用 `setState({count:11})`。
2. 这次嵌套 set 经 B/C 得到 state₁₁(count=11)，捕获它自己的 `previousState = state₁(count=1)`，并**立即启动内层 forEach**（A 没有重入保护）：
   - L1 又在 Set 里 → 第二次 `L1-plain(state.count=11, prev.count=1)`（`nested` 已为 true，不再递归）；
   - L2 在内层 Set 里 → `L2-plain(state.count=11, prev.count=1)`，这是它第一遍，拿到的上一次是中间值 `1`；
   - L3 的包装函数在内层被访问：旧切片缓存是订阅时拍的 `0`，新切片 `11`，D 放行 → `L3-sel(slice=11, prevSlice=0)`（全程只此 1 次）。
3. 内层 forEach 结束，控制权回到外层 forEach，外层迭代器**没有重放、也没有丢弃**，继续访问排在 L1 后面的成员，派发参数仍是外层在合并时一次性捕获的 `(state₁₁ 此刻..., previousState=state₀)`。注意外层传的 `state` 是同一个变量名引用，此刻它已被嵌套 set 改成 state₁₁，而 `previousState` 还是外层捕获的 state₀：
   - L2 在外层又被访问一次 → `L2-plain(state.count=11, prev.count=0)`，这是它第二遍。
   - L3 包装函数在外层再被访问：但 D 的缓存在内层第 2 步已经推进到 `11`，此刻新切片还是 `11`，闸门挡住，不再回调。

**"同一个人被叫两遍"指谁、为什么**：L1 与 L2 都是 2 次（读数 `L1-plain 2 次, L2-plain 2 次`），原因是它们既出现在**内层 forEach**（嵌套 set 同步触发的完整新一趟派发）里，又出现在**外层 forEach**（嵌套返回后继续走完的原趟派发）里。判据 A 对重入不做去重、不排队、不中断：一次嵌套 `setState` 就是一次全新的全量 `forEach`，而外层那趟也不会因为中途 state 又变了而作废。L3 形式上同样被两趟 forEach 各访问一次，但 D 让它只回调 1 次。

**为什么 L2 第二遍拿到的上一次是 0 而不是中间值 1**：每个 `setState` 的 `previousState` 都在各自合并前独立捕获（`src/vanilla.ts:74` `const previousState = state` → `:79`）。L2 的两次回调来自两套捕获：

- 内层那趟由嵌套 `setState({count:11})` 发起，它的 `previousState` 是当时的 state₁ → 上一次 `1`；
- 外层那趟由最初的 `setState({count:1})` 发起，它的 `previousState` 在 L1 嵌套发生**之前**就已定格为 state₀(count=0)，不会随中途 state 被改成 11 而更新 → 第二遍上一次仍是 `0`。

**中间那一跳 0→1 为什么没人"完整看见"**：

- L2 从未收到过"当前值为 1"的通知：内层派发时当前值已经是 11（上一次=1），外层派发时当前值也已被嵌套 set 改成 11（上一次=0）。所以它的两条日志当前值都是 11，`1` 只作为内层那趟的上一次出现。
- L3 看到的切片序列直接是 `0→11`（`prevSlice=0`），`1` 这一帧被 D 的缓存推进吞掉：它外层第一趟被访问时拿到的 state₁ 被 L1 的嵌套打断，等它真被访问时切片闸门用的是最新切片，内层已把缓存从 `0` 推到 `11`，外层再访问时 `11===11` 被静音。
- 唯一把 `1` 当作"当前值"收到过的是触发嵌套的 L1（`L1-plain(state.count=1, prev.count=0)`）；除它之外，中间值 `1` 对任何其他订阅者都不以"当前值"露面。最终内存读数为 `state.count=11`。

---

## 三、三次 set：原样返回的函数、空对象、同值键，各被叫几次

脚本第 3 段的完整读数（每轮新建 store，初始 `{count:1, other:'a'}`，各挂 1 条裸订阅与 1 条 `st.count` 选择器订阅）：

```
### 场景3: 判据层面（partial 与整个 state 比 / slice 与 slice 比）
set(s => s)           | 裸订阅调用=0 selector订阅调用=0 | state引用变化=false | count=1
set({}) 空对象         | 裸订阅调用=1 selector订阅调用=0 | state引用变化=true  | count=1
set({other:"a"})同值   | 裸订阅调用=1 selector订阅调用=0 | state引用变化=true  | count=1
```

汇总：

| set 写法 | 判据 B（入口） | 判据 C（合并） | 裸订阅 | 选择器订阅（切片 `count`） |
| --- | --- | --- | --- | --- |
| `set(s => s)` | 短路 | 不执行 | **0 次** | **0 次** |
| `set({})` | 放行 | 造新对象 | **1 次** | **0 次** |
| `set({ other:'a' })` | 放行 | 造新对象 | **1 次** | **0 次** |

逐行点名比较双方：

- **`set(s => s)`（原样返回的函数）**：`nextState = (x => x)(state)`，返回值就是当前 state 本体。判据 B 比较的是"合并前那半截"（这里即函数返回值）与**整个 state**：`Object.is(state, state)` 为真，`src/vanilla.ts:73` 直接短路，`:78` 的合并与 `:79` 的 forEach 都不执行。读数印证：`state引用变化=false`，裸订阅 0、选择器 0。注意裸订阅的 0 不是它自己判断的，而是 B 在它之上一层把整趟派发掐了。
- **`set({})`（空对象）**：`nextState` 是当场 new 出来的 `{}`，B 拿 `{}` 这个**合并前半截**与整个 state 比引用，必然不等，放行；随后 C 执行 `Object.assign({}, state, {})`，造出一个内容全等、引用全新的 state（`state引用变化=true`），forEach 照常派发，裸订阅对 state 引用变化不做任何二次判断，于是 **1 次**。选择器那条则轮到判据 D：`selector(新state).count === selector(旧state).count`（`1===1`，切片比切片），闸门挡住，**0 次**。
- **`set({ other:'a' })`（值跟原来相同的键）**：与空对象同形。B 比较的是 partial 对象 `{other:'a'}`（合并前半截）与整个 state，引用不等，放行；C 合并后 `state引用变化=true`，裸订阅 **1 次**；D 只看自己订阅的切片 `count`，新旧切片都是 `1`，**0 次**。键的值是否与旧值相等，B 和 C 都不看，只有 D（在它订阅的那个切片上）看。

两处"比较双方"点名收口：

- **判据 B（`src/vanilla.ts:73`）**：左边是**合并前那半截** `nextState`——函数式更新时是函数的返回值（`s => s` 时就是 state 自己），对象写法时就是调用方传进来的那个 partial 对象（`{}` / `{other:'a'}`）；右边是**整个当前 state**。比较发生在 `Object.assign` 之前，所以 `{}`、`{other:'a'}` 这种"内容等价"的写入在 B 眼里一律是"变了"。
- **判据 D（`src/middleware/subscribeWithSelector.ts:55`、`:58`）**：左边是订阅时缓存、并在每次回调后推进的**旧切片** `currentSlice`，右边是本次通知里 `selector(state)` 算出的**新切片** `nextSlice`；即**切片比切片**，state 其余字段是否换了引用与它无关。默认比较器是 `Object.is`，可被 `options.equalityFn` 替换。

裸订阅的次数完全由"B 放行后的 C+A"决定（引用变就响，响几次看派发了几趟，场景 2 已示同一轮可因重入响多次）；选择器订阅的次数则还要再由 D 按切片过滤一遍。

---

## 四、收口：四套判据能不能收成一套，收在哪一层、牵动谁

结论先说：**不能无损地收成一套，我选保持四套分离、各留在现在的层**（B/C/A 留在 `src/vanilla.ts`，D 留在 `subscribeWithSelector` 中间件）；如果硬要统一，代价由"裸订阅"这一侧的既有测试与用户承担，详见下。

四套判据回答的是四个不同问题，合在任何一层都会把另一层的语义吞掉：

- A 回答"一趟派发期间 Set 成员变动与重入怎么处理"，是**遍历时机**问题；
- B 回答"这次 set 值不值得开一趟派发"，比较粒度是**整个 state 的引用**，且故意发生在合并前；
- C 回答"新 state 用什么形状"，是**合并策略**（浅合并、必造新对象；`replace:true` 与非对象值又是另一条分支）；
- D 回答"这个选择器订阅者关不关心这次变化"，比较粒度是**调用方自选的切片与比较器**，天然只能是每订阅一份的状态（`currentSlice` 缓存），而 store 核心并不认识 selector。

两个理论上的合并方向，各自牵动的现有订阅测试：

**方向一：把 D 下沉进 vanilla，让核心按"值是否变化"统一过滤（B 与 D 合一）。**
核心没有 selector，只能对整个 state 做深比较，或给裸订阅引入等值短路；无论哪种，"浅合并后引用变了就要通知"这一现行契约会被破坏，直接翻红的现有用例：

- `tests/vanilla/subscribe.test.tsx` 的 `should be called if new state identity is different`（`setState({ ...getState() })` 期望以 `(initialState, initialState)` 被叫 1 次——内容全等、仅引用不同也必须响）。
- `tests/subscribe.test.tsx` 同名用例（React 绑定侧的同一条契约）。

反过来，若把核心保持引用语义、让中间件不再自己比较（D 上移/取消），则破坏切片契约，直接翻红：

- 两侧的 `should not be called when state slice is the same`（改无关字段，切片订阅不得响）；
- 两侧的 `should be called when state slice changes`（期望精确以 `(新切片, 旧切片)` 回调，正是 D 的 `previousSlice` 缓存语义）；
- 两侧的 `should not be called when equality checker returns true` 与 `should be called when equality checker returns false`（`equalityFn` 覆盖整个判据 D）；
- 两侧的 `should keep consistent behavior with equality check`（`tests/vanilla/subscribe.test.tsx`，自定义粗比较器与订阅内手写跳过的一致性）与 `should call listener immediately when fireImmediately is true`（`fireImmediately` 依赖订阅时 `currentSlice` 快照，`subscribeWithSelector.ts:55`、`:63`）。

**方向二：把 A 收成"快照式、无重入"的单趟派发（通知中新增/删除不影响本轮，嵌套 set 排队到本轮结束）。**
这能消掉场景一的"本轮迟到者"与场景二的重复回调/中间值错乱，但它是独立的第三件事，跟 B/D 的相等性合不到一起；现有测试目录里没有任何用例覆盖"通知中 subscribe"或"listener 内嵌套 setState"（`rg` 全仓 `tests/` 无相关断言），所以**改动它不会让现有测试条数变化**，代价全部由依赖现行同步重入语义的外部用户承担，且 `src/vanilla.ts:79` 的 `forEach` 与 `:74` 的 `previousState` 捕获方式都要重做，风险面反而最大、收益最间接。

**我的选择与代价归属**：维持四套分离。理由是 B（整 state 引用、合并前）与 D（每订阅切片、可换比较器）在比较对象、比较时机、状态归属三个维度上都不同，任何一层统一都意味着让另一层的公开契约失效；A 的遍历/重入语义则与相等性正交，不该借"统一判据"之名改时序。这样选的代价是：中间件用户必须接受"订阅瞬间切片已被拍下"（场景一的 late-sel 漏报本轮、`prevSlice=1`）与"嵌套 set 期间中间帧对其他订阅者不可见"（场景二）这两条由分层带来的行为，想规避只能在应用层不在监听器里嵌套 `setState`、或需要细粒度订阅时显式使用 `subscribeWithSelector` 并自行处理首帧；而核心与全部 224 条现有测试的契约不动。

---

## 附：测试条数（交件前后各跑一遍）

命令：`node_modules/.bin/vitest run`

- 交件前：**13 个测试文件全部通过，224/224 条测试通过**。
- 交件后：再次运行，文件数与通过条数必须与上一行完全一致（本变更只新增本文档，`src/` 与 `tests/` 零改动）。
