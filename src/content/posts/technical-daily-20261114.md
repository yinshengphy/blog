---
title: "技术深潜｜2026年11月14日"
date: "2026-11-14"
description: "围绕消息队列与异步架构的生产级技术推演、排障思路与 AI 应用项目推荐。"
tags: ["消息队列与异步架构", "Java", "系统设计", "AI 工程"]
categories: ["每日技术推送"]
---

【高级面试题｜2026-11-14】  
【今日方向】：消息队列与异步架构

### 场景 + 面试题

你负责一家电商平台的订单异步化改造：下单服务写入订单后，通过 Kafka 发布 `OrderCreated` 事件，库存、优惠券、积分、风控和通知服务分别消费。生产环境约 20 万条消息/秒，要求同一订单事件尽量有序；订单创建接口 P99 小于 150ms，核心链路允许最终一致，但库存不能重复扣减，支付成功后 5 分钟内必须完成订单状态推进。

部署 3 个可用区，Kafka 主题 96 个分区，消费者采用手动提交 offset。近期出现：

- 消费者重启或 Rebalance 后，同一订单被重复扣库存；
- 某个下游数据库短暂抖动时，Kafka Lag 持续上涨，恢复后出现大量重复处理；
- 少数订单出现“库存已扣，但订单仍是待支付”；
- 业务方要求“消息不能丢、不能重复、不能乱序”，同时不接受全链路分布式事务。

**问题：请设计一套生产可落地的消息可靠性与最终一致性方案，并说明在上述故障下如何定位和止损。**

**一句话结论：**不要承诺 MQ 的“全局 exactly-once”，应采用“至少一次投递 + 业务幂等 + Outbox/Inbox + 可重试状态机”，把一致性边界落在业务数据库和可观测的补偿流程上。

### 核心原理

1. **Kafka 只负责可靠传输，不负责业务副作用只执行一次**  
   消费成功但提交 offset 失败，重启后必然可能再次消费；因此“消息不重复”无法单靠 Kafka 保证。

2. **消息顺序只在分区内成立**  
   以 `orderId` 作为消息 Key，保证同一订单进入同一分区；不要依赖全局顺序。

3. **生产端用 Outbox 避免“数据库成功、消息没发出”**  
   订单和 Outbox 记录在同一个本地事务中提交，再由 Relay 异步投递 Kafka。

4. **消费端用 Inbox/业务唯一键实现幂等**  
   以 `eventId + consumerName` 或业务动作唯一键建立唯一索引，重复消息直接返回成功并提交 offset。

### 关键实现 + 工程取舍

生产端推荐：

```java
@Transactional
public void createOrder(CreateOrderCmd cmd) {
    Order order = orderRepo.insert(cmd); // 订单落库
    OutboxEvent event = new OutboxEvent(
        UUID.randomUUID().toString(),
        "OrderCreated",
        order.getId(),
        json(order)
    );
    outboxRepo.insert(event); // 与订单同一事务
}
```

Relay 发布成功后再把 Outbox 标记为 `SENT`；Relay 本身也允许重复投递，因此消费者必须幂等。Outbox 表要有状态、重试次数、下次重试时间、错误原因和创建时间，并支持按时间分片或归档。

消费端关键逻辑：

```java
@Transactional
public void consume(OrderCreatedEvent event) {
    int inserted = jdbc.update("""
        insert into inbox(event_id, consumer, created_at)
        values (?, ?, now())
        on conflict (event_id, consumer) do nothing
        """, event.id(), "inventory");

    if (inserted == 0) return; // 已处理，安全幂等

    inventoryService.reserve(
        event.orderId(),
        event.sku(),
        event.quantity(),
        event.id() // 业务动作幂等键
    );
    // 事务提交后再 ack/提交 Kafka offset
}
```

库存表还应有 `order_id + sku` 或 `reservation_id` 唯一约束，防止 Inbox 写入和业务执行之间出现异常时重复扣减。

**重试策略：**

- 可恢复错误：指数退避、抖动、限制最大次数；
- 不可恢复错误：进入 DLT，保留原消息、异常堆栈和业务上下文；
- 不要让单条毒消息阻塞整个分区，可使用重试主题或按业务类型拆分主题；
- 对支付、库存等核心动作采用“状态机 + 定时扫描补偿”，而非无限依赖 MQ 重试。

**工程取舍：**

- Kafka EOS 可减少 Kafka 读写链路中的重复，但无法覆盖外部数据库、RPC 和库存副作用，不能替代业务幂等；
- 同步写 Outbox 增加数据库写放大和发送延迟，但比双写更可靠；
- 分区数过多提升并行度，却增加 Rebalance、文件句柄和运维成本；
- 顺序与吞吐存在冲突：同一 `orderId` 保序即可，不要追求全局有序；
- 关键消费组应限制并发，避免下游数据库连接池被打满。

### 故障边界

- **订单已提交、Relay 未发送：**依赖 Outbox 扫描补发；
- **消息已发送、消费者处理成功、offset 未提交：**依赖幂等消费；
- **库存成功、订单状态更新失败：**由订单状态机和补偿任务继续推进；
- **消费者处理超时：**避免扩大 Kafka 可见性问题，应设置合理 poll/处理参数，并将长任务拆成异步任务；
- **下游永久失败：**进入 DLT，人工或自动修复后按原 eventId 重放；
- **无法接受重复副作用的场景：**必须把幂等约束下沉到数据库或外部系统，例如支付请求号、库存预占号。

### 监控排障 + 常见追问

**监控指标：**

- Kafka：各分区 Lag、消费速率、生产失败率、重试次数、Rebalance 次数、提交延迟；
- Outbox：待发送数量、最老消息年龄、发送失败率、扫描耗时；
- Inbox/业务：幂等命中率、处理成功率、异常类型、事务耗时；
- DLT：堆积量、最老消息年龄、按错误码和业务方分布；
- 业务一致性：订单状态与库存预占状态差异、支付成功未推进订单数。

**排障顺序：**

1. 用 `orderId/eventId` 串联订单表、Outbox、Kafka 分区及 offset、Inbox、库存流水和 DLT；
2. 判断是“未生产、未消费、消费失败、已成功但未提交 offset”，还是下游状态更新失败；
3. 对比消费 Lag 与消费者处理耗时，确认是分区热点、数据库慢、连接池耗尽还是 Rebalance；
4. 先限流或暂停非核心消费者，保护库存和数据库；
5. 修复根因后，从 DLT 或 Outbox 按 eventId 重放，验证幂等命中和业务状态闭环；
6. 禁止直接批量改库存，必须通过可审计的补偿命令或状态机修复。

**常见追问：**

- 为什么不能只依赖 Kafka exactly-once？  
  因为外部数据库提交不在 Kafka 事务内，跨系统副作用仍可能重复。

- 如何避免同一订单乱序？  
  使用 `orderId` 作为 Key；如果存在多主题依赖，使用版本号或状态机拒绝旧事件。

- 重试主题会不会破坏顺序？  
  会，因此需要按订单维度串行化，或用事件版本校验；非核心通知可以接受乱序。

- 如何处理消费者扩容后的热点订单？  
  单订单只能固定到一个分区，无法靠普通扩容解决，应拆分热点业务、降低单订单事件量或采用专门的串行执行器。

### AI 应用层 GitHub 项目推荐

**Mintplex-Labs/anything-llm**  
链接：https://github.com/Mintplex-Labs/anything-llm  
定位：本地优先的 AI Agent 应用平台，可用于理解 Agent、知识库和工具调用类应用的工程组织方式。  
语言：JavaScript；Star：68,249；最近更新：2026-11-13。
