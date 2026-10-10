---
title: "技术深潜｜2026年10月11日"
date: "2026-10-11"
description: "围绕系统设计与高并发架构的生产级技术推演、排障思路与 AI 应用项目推荐。"
tags: ["系统设计与高并发架构", "Java", "系统设计", "AI 工程"]
categories: ["每日技术推送"]
---

【高级面试题｜2026-10-11】
【今日方向】：系统设计与高并发架构

### 题目：百万级 TPS 爆品秒杀下，热点库存“行锁崩溃”与数据一致性架构设计

#### 1. 真实场景与故障现象
- **业务场景**：大促期间某顶级爆品秒杀（库存 5 万件），瞬间瞬时读请求 300 万 QPS，扣减写请求达 80 万 QPS。
- **系统表现**：
  1. MySQL 核心商品库 CPU 瞬间飙升至 100%，`show processlist` 显示大量处于 `searching rows for update` 或 `updating` 状态的线程堆积；
  2. 行级排他锁严重互斥，InnoDB 事务等待队列击穿 `innodb_lock_wait_timeout`（50s），大量抛出 `Lock wait timeout exceeded`；
  3. 应用层 Druid/HikariCP 连接池被打满，线程池积压耗尽，导致非热点商品交易链路被全面拖垮；
  4. 采用常规 Redis + Lua 方案防重与预扣时，单 Redis 节点因单 Key QPS 突破物理网卡及单线程瓶颈，CPU 跑满出现命令超时与网络丢包。
- **硬性约束**：严禁超卖；单 SKU 无法做物理拆分（前端展示与用户体验需保证强一致）；扣减失败需具备秒级回滚与重试能力。

---

#### 2. 一句话结论
**“热点隔离 + 动态内存分桶异步聚合 + 最终事务状态机逆向回滚”**：将集中式单行写争用降维为多级无锁批量操作，读写彻底分离，以无状态内存预扣抵御瞬时洪峰，以幂等事务账本保证数据库最终强一致。

---

#### 3. 核心原理
1. **写争用降维（Write Coalescing & Sharding）**：
   - 单行更新的物理极限取决于磁盘 IOPS 与单核锁竞争（MySQL 单行 Update 极限约 1000~3000 QPS）。
   - **动态分桶（Virtual Buckets）**：将单一物理库存虚拟拆分为 $N$ 个逻辑桶（Bucket-0 到 Bucket-$N-1$）。路由策略结合用户 ID Hash 与桶可用量探测，将单 Key 热点打散到 Redis Cluster 的不同分片甚至应用本地内存。
   - **写请求批处理（Batch Aggregation）**：在业务网关或专用扣减代理层，采用 LMAX Disruptor / RingBuffer 聚合 5ms 内针对同一分桶的扣减请求，转换为单次批量减库存（如合并为单条扣减 50）。
2. **动静分离与本地限流拦截**：
   - 本地基于 Guava/Caffeine 做短 TTL 的“售罄状态”黑名单广播（Local Blacklist）。一旦分桶或总库存归零，上游网关和本地直接 Fast-Fail，阻断 99% 的无效击穿流量。
3. **数据一致性兜底**：
   - 扣减只在 Redis 层做原子预扣并生成全局唯一流水号（Token）；
   - 异步化下沉到 DB：通过 RocketMQ/Kafka 事务消息落库持久化，DB 端基于“流水防重表 + 无锁 Insert 追加流水 + 定时/异步状态机轧差”，完全避开对主商品表的更新行锁。

---

#### 4. 关键实现（Disruptor 批处理聚合与 Redis 原子扣减）

```java
// 1. 基于 Disruptor 的写合并扣减器关键片段
public class StockBatchCoalescer {
    private final RingBuffer<StockDeductEvent> ringBuffer;

    public StockBatchCoalescer(int bufferSize, RedisTemplate<String, Object> redisTemplate) {
        Disruptor<StockDeductEvent> disruptor = new Disruptor<>(
            StockDeductEvent::new, bufferSize, DaemonThreadFactory.INSTANCE,
            ProducerType.MULTI, new BlockingWaitStrategy());

        disruptor.handleEventsWith((event, sequence, endOfBatch) -> {
            // 聚合批次内请求，达到单批上限或 endOfBatch 时一次性扣减
            BatchCollector.add(event);
            if (endOfBatch || BatchCollector.size() >= 50) {
                executeBatchDeduct(BatchCollector.drain(), redisTemplate);
            }
        });
        this.ringBuffer = disruptor.start();
    }

    private void executeBatchDeduct(List<StockDeductEvent> batch, RedisTemplate<String, Object> redisTemplate) {
        int totalDeduct = batch.stream().mapToInt(StockDeductEvent::getCount).sum();
        // 执行 Lua 脚本扣减当前分配的虚拟桶
        Long remaining = (Long) redisTemplate.execute(DEDUCT_LUA_SCRIPT, 
                Collections.singletonList("stock:bucket:" + batch.get(0).getBucketId()), totalDeduct);
        boolean success = remaining != null && remaining >= 0;
        batch.forEach(e -> e.getFuture().complete(success));
    }
}
```

```lua
-- 2. 虚拟分桶原子扣减 Lua 脚本 (stock_deduct.lua)
local key = KEYS[1]
local deductCount = tonumber(ARGV[1])
local currentStock = tonumber(redis.call('get', key) or "0")

if currentStock >= deductCount then
    redis.call('decrby', key, deductCount)
    return currentStock - deductCount
else
    return -1 -- 库存不足，由应用层决定路由至下一个分桶或直接失败
end
```

#### 5. 工程取舍
| 维度 | 方案 A：DB 直接悲观锁 / `FOR UPDATE` | 方案 B：Redis 单 Key 预扣 + MQ 异步落库 | 方案 C：分桶写合并 + 最终事务轧差（推荐） |
| :--- | :--- | :--- | :--- |
| **吞吐极限** | 极低（~2K QPS），容易打死数据库 | 中等（受限于单 Redis 节点 8~10W QPS） | 极高（百万级 QPS，线性水平扩展） |
| **系统复杂度** | 极低，事务由 DB 保证 | 中等，需处理 Redis 崩坏与超卖校验 | 较高，需实现桶平衡、重试及逆向平账 |
| **库存实时性**| 强一致 | 弱一致（存在 MQ 消费延迟） | 最终一致，前端显示允许秒级延迟 |
| **超卖风险** | 绝对无超卖 | 依赖 Redis 持久化，AOF 丢失可能超卖 | 分桶限额严格对齐，底层流水轧差无超卖 |

---

#### 6. 故障边界
1. **分桶倾斜（Bucket Skewing）**：某个桶被分配过量请求迅速打空，而其他桶仍有充足库存，导致用户看到“售罄”但实际仍有库存。
   - *应对*：客户端感知单桶失败后，允许且仅允许做 **1 次再路由重试**（向全局负载最低的桶发起）；若剩余总库存低于阈值（如总库存 < 1000），动态收拢合并为一个主桶并开启强行限流。
2. **应用节点宕机与丢消息**：RingBuffer 批处理中聚合的扣减尚未发送给 Redis，服务突然下线。
   - *应对*：扣减响应完全基于异步 Future 回调。进程崩溃前若未收到 ACK，上游网关会收到断开或超时，直接判定该批次失败并释放用户请求；库存未在 Redis 实际扣减，不存在数据腐败。
3. **Redis 扣减成功但 MQ 发送失败/宕机**：
   - *应对*：Redis 原子操作中同时写入基于时间戳的 Deduct-Log。后台对账定时任务扫描 Redis 流水与 DB 落库流水，超过 1 分钟未落库的执行对账平账，主动发起重试或逆向回补。

---

#### 7. 监控排障
1. **排查指标重点**：
   - **MySQL 层面**：监控 `Innodb_row_lock_current_waits`（当前行锁等待数）与 `Innodb_row_lock_time_avg`。若等待数超过 50，必须立即启动上游熔断降级。
   - **JVM 层面**：监控 Disruptor RingBuffer 的剩余容量（`ringBuffer.remainingCapacity()`）与 GC 停顿；若积压升高，说明 Redis 响应延迟劣化。
   - **业务指标**：监控各虚拟分桶的扣减倾斜率（标准差），偏离度 > 30% 需动态调节 Hash 种子。
2. **现场排障指令**：

```bash
   # 1. 抓取 MySQL 锁等待链，识别阻塞源头事务
   SELECT r.trx_id waiting_trx_id, r.trx_mysql_thread_id waiting_thread,
          b.trx_id blocking_trx_id, b.trx_mysql_thread_id blocking_thread,
          b.trx_query blocking_query
   FROM performance_schema.data_lock_waits w
   JOIN information_schema.innodb_trx b ON b.trx_id = w.blocking_engine_transaction_id
   JOIN information_schema.innodb_trx r ON r.trx_id = w.requesting_engine_transaction_id;

   # 2. 检查 Redis 单线程 CPU 消耗与热点 Key 执行频率
   redis-cli -p 6379 --hotkeys
   redis-cli -p 6379 latency doctor
   ```

---

#### 8. 常见追问
1. **追问 1**：“分桶后，如果用户一次购买数量大于单个桶的剩余库存，跨桶扣减如何保证原子性？”
   - *回答*：绝不采用跨分片分布式事务（如 Redis 跨节点 MULTI/EXEC 不可用）。策略是优先满足能够单桶扣减的请求；若大额订单必须拆桶，走两阶段预占（Reserve-Commit）机制：先锁定各桶额度，全部锁定成功再扣除，任意桶锁定失败则全量逆向补偿释放。
2. **追问 2**：“如果 Redis Master 宕机，主从切换发生数据丢失，导致库存超卖怎么办？”
   - *回答*：在持久层设计“真实库存底线约束”。DB 中更新库存采用严格的无符号字段或校验子句：`UPDATE stock SET count = count - delta WHERE count >= delta`。Redis 允许偶尔多放流量（充当挡箭牌），若底层因 Redis 丢失数据导致 DB 扣减返回影响行数 0，说明发生极端超卖，此时触发“业务兜底方案”（如转入缺货重采购补偿流程或触发自动退款退单）。

---

#### 9. 推荐开源项目
- **项目**：microsoft/autogen
- **地址**：https://github.com/microsoft/autogen
- **语言**：Python | **Stars**：61343
- **推荐理由**：A programming framework for agentic AI。在设计超高并发与自动化故障诊断系统时，可借助其多 Agent 协作框架，构建针对复杂分布式中间件与链路指标的自动化巡检、故障根因分析与自愈决策 Agent。
