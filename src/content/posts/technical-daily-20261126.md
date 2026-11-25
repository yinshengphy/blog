---
title: "技术深潜｜2026年11月26日"
date: "2026-11-26"
description: "围绕消息队列与异步架构的生产级技术推演、排障思路与 AI 应用项目推荐。"
tags: ["消息队列与异步架构", "Java", "系统设计", "AI 工程"]
categories: ["每日技术推送"]
---

【高级面试题｜2026-11-26】
【今日方向】：消息队列与异步架构

一句话结论：在“数据库写入与消息发送不能依赖分布式事务”的前提下，应采用事务性 Outbox 保证事件不丢失，再用消费者幂等、有限重试和死信补偿控制重复与故障扩散；不要承诺端到端 Exactly-Once。

**场景**

你负责一个电商订单系统：下单接口写入 MySQL 后，需要异步通知库存、支付、优惠券和履约服务。生产环境使用 Kafka，3 个可用区，峰值 8,000 条订单事件/秒，要求订单成功后 3 秒内完成事件投递，订单不能因 MQ 短暂故障而丢失，库存扣减不能重复。

约束如下：

- 订单库和 Kafka 无法使用全局分布式事务；
- 下游服务可能超时、重启或重复消费；
- Kafka 允许至少一次投递，消息保留 7 天；
- 不能通过无限重试拖垮下游；
- 需要支持事件追踪、人工补偿和审计。

上线后出现以下现象：部分订单状态已成功但库存没有扣减；消费者重平衡后库存偶发重复扣减；Kafka Consumer Lag 持续升高；部分消息重试数很高但最终没有进入死信队列。

**问题**

请设计这套消息驱动架构，并说明：如何保证消息不丢、如何实现消费幂等、如何设计重试与死信、如何定位上述故障，以及在吞吐、延迟、一致性和运维复杂度之间如何取舍。

**核心原理**

1. **生产端不直接“写库后发消息”**  
   订单和 Outbox 事件在同一个本地数据库事务中提交。订单提交成功，事件必然落库；订单失败，事件不会存在。

2. **异步 Relay 投递 Kafka**  
   Relay 扫描未发送 Outbox，发送成功后更新状态。发送与状态更新之间可能重复，因此 Kafka 端必须接受重复，不能依赖 Relay 的“只发一次”。

3. **消费端至少一次 + 业务幂等**  
   以 `eventId` 或业务唯一键建立消费记录；库存扣减还应使用订单号、商品行号等业务幂等键，不能只依赖 Kafka offset。

4. **Exactly-Once 的边界**  
   Kafka 事务可以覆盖 Kafka 内部生产与消费，但不能覆盖 MySQL、库存服务和外部支付系统。真正的端到端 Exactly-Once 通常不可得，应设计为“至少一次消息 + 幂等业务结果”。

**关键实现**

```java
@Transactional
public void createOrder(Order order) {
    orderRepo.insert(order);
    OutboxEvent event = new OutboxEvent(
        UUID.randomUUID().toString(),
        "ORDER_CREATED",
        order.getId(),
        serialize(order)
    );
    outboxRepo.insert(event); // 与订单同库同事务
}

public void consume(OutboxEvent event) {
    if (consumeRepo.exists(event.id())) return;

    transactionTemplate.execute(status -> {
        inventoryService.deductIfAbsent(
            event.aggregateId(), event.id()); // 唯一键防重复
        consumeRepo.insert(event.id(), now());
        return null;
    });
}
```

Relay 应采用批量拉取、状态机和租约字段，例如 `NEW → SENDING → SENT`；`SENDING` 超时后可重置，避免 Relay 崩溃导致事件永久卡住。Kafka key 使用订单号或聚合根 ID，保证同一订单在分区内有序。

**工程取舍与故障边界**

- Outbox 增加数据库写放大、表膨胀和 Relay 运维成本；应按时间归档，并为状态、创建时间建立索引。
- 重试应区分可恢复错误与业务拒绝：网络超时、限流可重试；参数非法、订单不存在通常直接进入死信。
- 使用指数退避和抖动，例如 1s、5s、30s、5min；超过次数后进入重试 Topic 或 DLQ，禁止消费者线程无限 sleep。
- DLQ 必须保留原消息、异常堆栈、重试次数、首次失败时间和业务键，并提供人工重放能力。
- 消费成功后再提交 offset；但“业务已成功、offset 未提交”仍会重复，所以幂等是必须的。
- Kafka Lag 高不一定是 Kafka 故障，也可能是消费线程阻塞、下游限流、批量参数不合理或分区数不足。

**监控与排障**

先用 `traceId、eventId、orderId` 串联订单库、Outbox、Kafka、消费者和库存服务，构建链路状态：

1. 订单成功但无消息：查订单事务是否同时写入 Outbox；再查 Outbox 状态、Relay 错误、发送确认和 Kafka Topic。
2. Lag 持续升高：看生产速率与消费速率、分区热点、Consumer rebalance、线程池队列、下游 P99 和错误率。
3. 库存重复扣减：检查幂等表唯一约束、事务边界、消费提交时机，以及是否存在按错误字段去重。
4. 重试很多却无 DLQ：检查重试 Topic 路由、TTL/延迟机制、死信生产权限、消费者异常吞掉问题和监控告警。
5. 消息延迟超过 3 秒：区分 Outbox 未及时发送、Kafka 排队、消费处理慢和下游响应慢，分别看各阶段时间戳。

**常见追问方向**

- Outbox 表达到千万级后如何分库分表、归档和避免扫描放大；
- 如何处理同一订单不同事件的顺序与乱序；
- Kafka 分区扩容后 key 与顺序保证如何变化；
- 消费者扩容、重平衡和优雅停机如何减少重复；
- 跨服务最终一致性失败时，补偿任务如何做到可重入、可审计。

**AI 应用层 GitHub 项目推荐**

[Mintplex-Labs/anything-llm](https://github.com/Mintplex-Labs/anything-llm)：描述为“Stop renting your intelligence. Own it with AnythingLLM. Everything you need for a powerful local-first agent experience”；语言：JavaScript；Stars：68,642；最近更新：2026-11-25。
