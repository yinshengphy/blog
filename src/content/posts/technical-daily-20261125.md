---
title: "技术深潜｜2026年11月25日"
date: "2026-11-25"
description: "围绕Redis 与高性能缓存的生产级技术推演、排障思路与 AI 应用项目推荐。"
tags: ["Redis 与高性能缓存", "Java", "系统设计", "AI 工程"]
categories: ["每日技术推送"]
---

【高级面试题｜2026-11-25】  
【今日方向】：Redis 与高性能缓存

### 场景+问题

某电商平台的商品详情接口采用 Redis Cluster + MySQL，日常流量 8 万 QPS，秒杀期间峰值 30 万 QPS；其中一个爆款商品占总请求量的 35%。约束如下：

- 商品详情要求 p99 < 30ms，允许最多 3 秒旧数据；
- MySQL 单集群安全承载上限约 2 万 QPS；
- Redis 集群 6 个分片，不能简单无限扩容；
- 商品价格、库存变更后，缓存原则上 1 秒内可见；
- 不能因为缓存故障拖垮数据库。

故障现象：

1. 每天凌晨批量刷新商品时，大量缓存同时过期；
2. Redis 主节点故障转移约 8 秒期间，商品接口 p99 从 20ms 升到 2 秒，MySQL 连接池打满；
3. 热门商品偶发返回旧价格，且某些不存在的商品请求持续打到数据库；
4. Redis CPU 并不总是满，但单个热点 Key 所在分片延迟明显升高。

**问题：请你设计这套缓存，并说明如何解决缓存击穿、雪崩、穿透、热点 Key、数据一致性和 Redis 故障转移问题；同时说明监控指标、排障顺序及工程取舍。**

### 一句话结论

生产级方案不是“所有请求都查 Redis”，而是采用“多级缓存 + 防击穿并发控制 + TTL 随机化 + 逻辑过期兜底 + 降级限流 + 事件驱动失效”的组合方案。

### 核心原理

- **缓存穿透**：对不存在商品做短 TTL 空值缓存，并在入口增加参数校验；高风险场景可加 Bloom Filter。
- **缓存击穿**：热点 Key 不直接依赖物理 TTL，使用逻辑过期；只有一个线程负责异步重建，其余请求返回旧值。
- **缓存雪崩**：TTL 加随机抖动，批量预热分批执行，避免同一时刻集中失效。
- **热点 Key**：本地 Caffeine 缓存承接热点读请求，Redis 中对热点数据做副本或拆分 Key；避免单个 Redis Key 成为串行瓶颈。
- **一致性**：商品变更先提交数据库，再通过 Outbox/MQ 发布失效事件；消费者删除 Redis 和本地缓存。对价格等强敏感字段，可采用短 TTL、版本号校验或读源兜底。
- **故障保护**：Redis 超时不能无限重试；进入熔断、限流、旧值返回或受控降级，严禁所有请求直接回源。

---

### 原理+实现+取舍

推荐缓存结构：

```java
record CacheValue<T>(
    T data,
    long logicalExpireAt,
    long version
) {}

public Product getProduct(long id) {
    Product local = caffeine.getIfPresent(id);
    if (local != null) return local;

    String key = "product:" + id;
    CacheValue<Product> cv = redis.get(key, PRODUCT_TYPE);

    if (cv != null) {
        if (cv.logicalExpireAt() > System.currentTimeMillis()) {
            caffeine.put(id, cv.data());
            return cv.data();
        }
        // 逻辑过期：只允许一个线程异步刷新，其余请求返回旧值
        refreshExecutor.submit(() ->
            singleFlight.refresh(key, () -> loadAndRebuild(id)));
        return cv.data();
    }

    return singleFlight.execute(key, () -> {
        CacheValue<Product> latest = redis.get(key, PRODUCT_TYPE);
        if (latest != null) return latest.data();

        Product p = productDao.find(id);
        if (p == null) {
            redis.setex("product:empty:" + id, 10, "1");
            return null;
        }

        long ttl = 300 + ThreadLocalRandom.current().nextLong(60);
        redis.setex(key, ttl, encode(new CacheValue<>(
            p, System.currentTimeMillis() + 300_000, p.version())));
        caffeine.put(id, p);
        return p;
    });
}
```

关键实现：

1. **single-flight** 按商品 ID 合并并发回源，锁必须有超时，不能使用无限期分布式锁。
2. **逻辑过期**适合详情、推荐等允许短暂旧数据的接口；库存、余额等不能仅依赖旧值。
3. **删除策略**：数据库事务提交成功后发送失效事件；事件消费失败进入重试队列和死信队列。
4. **版本控制**：缓存值携带数据库版本，异步刷新时拒绝旧版本覆盖新版本。
5. **批量刷新**：按商品分片、限速、错峰预热，不能一次性 `MGET` 数百万 Key 后集中写入。
6. **Redis Cluster**：避免把大量热点请求集中到一个槽；但不要机械地给普通 Key 加随机后缀，否则会增加聚合读取复杂度。只有确认热点 Key 后，才做可控副本拆分。

工程取舍：

- 本地缓存降低 Redis 压力，但会引入节点间短暂不一致和内存占用；
- 逻辑过期提高可用性，但允许返回旧数据；
- 失效事件降低同步链路延迟，但需要处理消息丢失、重复消费和乱序；
- Redis 读超时后的回源必须有全局并发上限，否则“缓存故障保护”会变成数据库雪崩。

---

### 故障边界+监控排障+常见追问

**Redis 主从切换期间：**

- Redis 客户端设置连接、命令、池获取超时，禁止无限重试；
- 对读请求：优先本地缓存，其次返回逻辑未过期或允许短暂过期的数据；
- 对无法返回的请求：按接口重要性限流、快速失败或返回兜底结果；
- 只有极少量请求允许回源，且通过信号量限制数据库并发；
- 不把 Redis 故障排查重点转向容器编排，先确认 Redis、客户端和数据库链路。

**监控指标：**

- Redis：命中率、命令延迟分位数、slowlog、各分片 QPS/CPU/内存、热 Key、连接池等待、主从复制延迟、拒绝连接数；
- 应用：本地缓存命中率、single-flight 等待数、回源 QPS、空值命中率、线程池队列、熔断/限流次数；
- 数据库：连接池使用率、慢 SQL、QPS、锁等待；
- 一致性：缓存版本落后量、失效事件堆积、重试/死信数量。

**排障顺序：**

1. 先看接口 p99、错误率和回源 QPS，确认是否已形成数据库放大；
2. 分析 Redis 分片延迟和热点 Key，区分单 Key 热点还是整体容量问题；
3. 查看主从复制延迟、故障转移时间、客户端重试风暴；
4. 核查 TTL 分布，判断是集中过期还是单个热点击穿；
5. 检查本地缓存、失效消息和版本号，定位旧数据来源；
6. 最后核对数据库连接池、慢 SQL 和锁等待，避免只盯 Redis。

**常见追问：**

- 为什么不用 Redis 分布式锁解决所有击穿？  
  锁只能控制重建并发，不能解决 Redis 不可用、锁超时、旧值返回和数据库过载；应结合 single-flight、逻辑过期和限流。

- 删除缓存为什么不放在数据库更新之前？  
  先删缓存再更新数据库，可能被并发读请求重新写入旧值；通常先提交数据库，再通过可靠事件删除缓存。

- 热点 Key 加随机后缀有什么问题？  
  会把一个逻辑值拆成多个物理 Key，更新和读取更复杂；应只对确认的极热点使用，并配合版本或统一失效。

### AI 应用层 GitHub 项目推荐

**Aider-AI/aider**  
- 描述：aider is AI pair programming in your terminal  
- 语言：Python  
- Stars：50,244  
- 地址：https://github.com/Aider-AI/aider
