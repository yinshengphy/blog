---
title: "技术深潜｜2026年11月07日"
date: "2026-11-07"
description: "围绕AI 工程与大模型应用开发的生产级技术推演、排障思路与 AI 应用项目推荐。"
tags: ["AI 工程与大模型应用开发", "Java", "系统设计", "AI 工程"]
categories: ["每日技术推送"]
---

【高级面试题｜2026-11-07】
【今日方向】：AI 工程与大模型应用开发

### 生产真实场景与故障
**业务背景**：某金融机构的智能投研 Agent 系统，底层基于 Spring AI / Java 21 虚拟线程与 Netty 构建 SSE（Server-Sent Events）流式网关。系统提供多轮 ReAct Agent 能力，集成向量检索（RAG）、SQL 执行及外部行情 API 调用，最终将 LLM 生成的 Markdown 及图表 Token 流式推送至前端。

**运行约束**：
1. 上游大模型 API 限制 TPM/RPM，并按输出 Token 强计费；
2. 移动端/弱网用户占比超 30%，客户端网络消费能力不均；
3. 单次会话上下文预算严格限制在 32k Token，多轮 Function Calling 步数上限为 5 步；
4. 核心系统 SLA 要求 P99 首字延迟（TTFT）< 1.5s，生成断流率 < 0.1%。

**故障现象**：
在早盘高峰期，网关服务 JVM 堆内存与堆外内存急剧飙升，频繁触发 FullGC；大量用户反馈“生成卡死在半途”或“前端接收白屏后连接被 Reset（RST）”；云端 LLM 账单暴增，出现大量“用户已关闭网页但后台仍持续调用大模型推理 60s 以上”的幽灵调用；监控显示服务端大量产生 `OutOfMemoryError: Direct buffer memory` 与 Netty 管道写缓冲区积压。

---

### 一句话结论
在异步流式 Agent 架构中，**未打通端到端响应式背压（Backpressure）与客户端断开感知（Cancellation Token）**，叠加**无界上下文追加与 Agent 递归工具调用的重试放大**，是导致 Netty 内存击穿、算力幽灵计费与级联雪崩的根源。

---

### 核心原理
1. **慢客户端引发 Netty 缓冲击穿**：LLM 上游以 40~80 tokens/s 的速度向 Java 网关持续推送数据，而弱网客户端 TCP 接收窗口打满。Netty 的 Channel 写入若未配置高低水位线（`WriteBufferWaterMark`）及响应式背压，会导致未发送的 Frame 滞留在 JVM 堆内或 DirectByteBuffer，瞬间引发内存泄漏和 GC 停顿。
2. **生命周期割裂与幽灵推理**：浏览器端由于超时或用户主动中断 SSE 连接（TCP FIN/RST），网关的 Netty IO 线程虽触发 `channelInactive`，但若异步编排链路（如 Reactor 的 `Flux` 或 CompletableFuture）未注册取消回调，后台将继续驱动 LLM 发起后续多轮 Tool Call，浪费数万 Token 成本。
3. **ReAct 循环中的上下文膨胀与死循环**：当 Tool 执行异常或返回结构与 LLM 预期不符时，LLM 易产生自纠错循环（Self-Correction Loop）。无防爆策略时，每次错误信息追加导致上下文指数级膨胀，不仅极速耗尽 TPM 配额，还会引发 LLM 生成延迟非线性剧增。

---

### 关键实现（防穿透流式 Agent 网关）

```java
@RestController
@RequestMapping("/api/v1/agent")
public class StreamAgentController {

    private final ChatModel chatModel;
    private final ToolCallbackProvider toolCallbackProvider;

    public StreamAgentController(ChatModel chatModel, ToolCallbackProvider toolCallbackProvider) {
        this.chatModel = chatModel;
        this.toolCallbackProvider = toolCallbackProvider;
    }

    @PostMapping(value = "/chat/stream", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public Flux<ServerSentEvent<String>> streamChat(@RequestBody ChatRequest request) {
        // 1. 严格动态上下文滑窗剪枝，防御 Token 爆炸
        List<Message> prunedMessages = ContextPruner.prune(request.getHistory(), 30_000);
        
        // 2. 状态机跟踪单次会话的 Function Calling 深度与累计消耗
        AgentBudget budget = new AgentBudget(maxSteps = 5, maxTokens = 4096);

        Prompt prompt = new Prompt(prunedMessages, 
            ChatOptionsBuilder.builder()
                .withFunctionCallbacks(toolCallbackProvider.getCallbacks())
                .build());

        return chatModel.stream(prompt)
            // 3. 消费端背压策略：当下游消费不过来时，缓冲溢出直接丢弃或触发降级，防 Netty OOM
            .onBackpressureBuffer(
                128, // 限制内部缓冲大小
                dropped -> log.warn("Client slow, drop token: {}", dropped),
                BufferOverflowStrategy.DROP_LATEST
            )
            // 4. 递归与步数限制：在流式过程中熔断失控的 Agent
            .takeWhile(chunk -> budget.incrementAndCheck(chunk))
            .map(chunk -> ServerSentEvent.<String>builder()
                .data(chunk.getResult().getOutput().getContent())
                .build())
            // 5. 核心：客户端主动断开连接时，级联发送中断信号至 LLM HTTP Client
            .doOnCancel(() -> {
                log.info("Client disconnected, canceling upstream LLM generation. Session: {}", request.getSessionId());
                budget.markCancelled();
            })
```

```java
            // 6. 异常快速降级兜底，不给前端返回半截未解析结构
            .onErrorResume(ex -> Flux.just(
                ServerSentEvent.<String>builder()
                    .event("error")
                    .data("系统繁忙或上下文过载，已安全熔断: " + ex.getMessage())
                    .build()
            ));
    }
}
```

### 工程取舍
1. **反压策略的丢弃 vs 阻塞（Drop vs Block）**：
   - *取舍*：对于普通数据流可采用阻塞式反压（Block 上游推流），但大模型厂商 API 是 Server-Sent 推送，服务端无法让上游厂商暂停。因此网关层选用 **限容缓冲 + 尾部丢弃（Drop Latest）** 或 **动态合并 Token 块（Buffer-Timeout 批聚合推送）**，牺牲极弱网用户的平滑字流体验，换取服务整体的高可用与低内存占用。
2. **多轮 Tool Calling 的流式透传 vs 聚合校验**：
   - *取舍*：实时将 Tool 执行参数流式解析给前端虽然“酷炫”，但一旦 LLM 输出的 JSON 参数半途解析失败，前端难以回滚状态。生产环境选择**在网关内部将 Tool Call 聚合校验后再执行**，仅将最终思考摘要和生成的最终文本以 SSE 形式暴露给终端。

---

### 故障边界与自愈设计
1. **Netty 堆外水位线防护**：在网关配置 `ChannelOption.WRITE_BUFFER_WATER_MARK = new WriteBufferWaterMark(32 * 1024, 64 * 1024)`。当写队列超过 64KB，`channel.isWritable()` 变为 false，此时暂停拉取上游 Reactor 流，防止慢客户端拖垮 DirectByteBuffer。
2. **Ghost Request 斩草除根**：大模型上游 HTTP Client（如 WebClient / OkHttp）必须与 Spring SSE 的取消信号联动。当 `doOnCancel` 触发时，立即调用底层 HTTP Request 的 `cancel()`，使厂商网关立刻停止扣费和 Token 推送。
3. **Agent 递归死循环断路器**：记录工具调用历史特征（Tool Name + Arguments Hash），一旦检测到相同参数连续调用 2 次未果，强制注入 System 消息提示 LLM：“工具执行无有效进展，请直接根据已知事实总结”，杜绝无效死循环。

---

### 监控排障体系
1. **核心度量指标**：
   - **TTFT (Time To First Token)**：排查上游冷启动或 RAG 检索耗时。
   - **TPS (Tokens Per Second)**：监控客户端消费速率与服务端下发速率差值。
   - **Zombie Task Ratio（幽灵会话率）**：客户端 `Cancel` 发生但 LLM 请求未正常 Abort 的比例（目标为 0）。
   - **Netty Direct Memory Usage**：堆外内存利用率告警阈值设定在 75%。
2. **排障诊断命令**：

```bash
   # 1. 确认 Netty 堆外内存泄漏点（排查 ByteBuf 是否正常 release）
   jcmd <PID> VM.native_memory baseline
   jcmd <PID> VM.native_memory detail.diff

   # 2. 查看当前持有的 SSE 长连接数及 TCP 接收队列溢出情况
   ss -s
   netstat -s | grep "buffer errors"
   ```

---

### 常见追问
1. **追问**：如果在 Agent 执行耗时工具（如运行 SQL 20秒）期间，SSE 连接没有任何数据产生，前端被网关或云供应商 ALB 报 504 超时断开怎么办？
   - *回答*：建立保活心跳机制。在 Tool 执行期间，服务端通过单独的定时流（`Flux.interval`）向客户端下发 SSE 注释包（如 `:ping\n\n`）或业务状态更新（如 `{"event":"status","data":"正在查询报表..."}`），维持 TCP Keep-Alive 与应用层保活。
2. **追问**：RAG 召回过多 Chunk 导致 Prompt 接近上下文窗口上限时，除了硬截断，生产上有哪些成熟工程策略？
   - *回答*：采用双层处理：第一阶段用 Small-LM 或 Cross-Encoder 进行 Re-ranking 剔除低相关 Chunk；第二阶段基于语义密度进行 Context Compression（提取句子中的实体与命题），或在网关引入 Map-Reduce 归纳策略，将单次超长 Prompt 拆解后再组装输入。

---

### GitHub 项目推荐
**The-Vibe-Company/quivr**
- **URL**: https://github.com/The-Vibe-Company/quivr
- **Language**: Go | **Stars**: 39,632 | **Updated**: 2026-11-06
- **推荐理由**: 这是一个专为连续内容流提供高韧性摄取（Durable Ingestion）、混合检索（Hybrid Search）和监控警报的开源引擎。在构建高可用 RAG 和 Agent 系统时，其针对持久化数据流管道、格式与业务规则插件化的设计，为解决流式数据灌入及长上下文检索提供了高并发工业级参考。
