---
title: "技术深潜｜2026年10月23日"
date: "2026-10-23"
description: "围绕系统设计与高并发架构的生产级技术推演、排障思路与 AI 应用项目推荐。"
tags: ["系统设计与高并发架构", "Java", "系统设计", "AI 工程"]
categories: ["每日技术推送"]
---

【高级面试题｜2026-10-23】
【今日方向】：系统设计与高并发架构

### 生产面试真题：单 SKU 秒级 10 万 QPS 闪购下的热点库存扣减架构与脑裂一致性防护

#### 1. 真实场景与业务约束
* **业务背景**：电商平台“大促超级秒杀”活动，单款爆品 SKU（库存量仅 10,000 件）瞬时访问流量达到 100,000 QPS。
* **系统约束**：
  1. **零超卖底线**：物理库存绝对不能扣为负数；
  2. **高吞吐低延迟**：核心扣减链路 P99 要求在 30ms 以内；
  3. **单机 DB 瓶颈**：后端采用 MySQL 8.0 InnoDB 引擎，单行记录 `UPDATE ... WHERE id = ?` 行级排他锁的极限吞吐仅为 800~1,200 TPS；
  4. **幂等性要求**：网络抖动导致的客户端重试不能引发重复扣减。
* **生产故障现象**：
  大促启动瞬间，由于使用了传统的“Redis 预扣减 + MQ 异步落库”架构，Redis 主节点突发瞬时网络分区触发哨兵主从切换；部分客户端在切换瞬态收到连接超时后进行全量重试。下游 MQ 消费者积压超百万，DB 连接池迅速耗尽并产生大量 `Lock wait timeout exceeded` 异常；主从切换完成新主挂载后，因复制延迟导致已扣减数据丢失，出现严重**超卖 3,400+ 件**，同时对账系统报警“库存与订单总额不平衡”。

---

#### 2. 一句话结论
**必须抛弃单行强锁与单纯异步 MQ 依赖，采用“内存多维分桶预扣 + Redis 原子 Lua 配额校验 + 客户端防重令牌 + 事务性乱序双向幂等落库（流水号回执对账）”，配合租约/版本号栅栏机制阻断集群脑裂漂移。**

---

#### 3. 核心原理
1. **读写动静完全分离与削峰下沉**：
   * 读链路走 CDN / Nginx 本地缓存（OpenResty 共享内存 + HTTP 强缓存），完全阻断查询流量击穿至后端。
   * 写链路通过网关进行用户维度的令牌桶限流，过滤无效重复点击与刷子请求。
2. **热点库存分桶与原子化扣减**：
   * 将单一物理 SKU 的库存均分为 $N$ 个独立分桶（如 `sku_1001_bucket_0` 到 `sku_1001_bucket_9`）。用户请求按 `UserId % N` 路由到对应分桶，将单点热点竞争稀释 $N$ 倍。
   * 单桶内通过 Redis Lua 脚本原子执行“校验可用库存 -> 扣减分桶 -> 记录扣减流水（保留防重幂等号与扣减配额）”。
3. **版本栅栏（Fencing Token）对抗主从漂移**：
   * 采用携带单调递增版本号/租约的令牌机制。当 Redis 发生主从切换后，新主节点持有更高世代（Epoch），旧主丢弃或被降级，防止主从切换瞬间双写导致数据不一致。
4. **异步事务持久化与合并提交（Batch Aggregation）**：
   * 落库阶段采用“异步聚合 Worker”，在内存队列中将 100ms 窗口内的数百个订单扣减请求合并为一条批量扣减 SQL（`UPDATE stock SET remain = remain - ? WHERE id = ? AND remain >= ?`），大幅减轻 DB 单行锁冲突。

---

#### 4. 关键实现（Java + Redis Lua 关键片段）

##### 1) Redis Lua 扣减脚本（包含幂等性检查与分桶记录）

```lua
-- KEYS[1]: bucket_stock_key, KEYS[2]: idempotent_record_key
-- ARGV[1]: deduct_num, ARGV[2]: request_token, ARGV[3]: expire_time
if redis.call('EXISTS', KEYS[2]) == 1 then
    return 1 -- 已经扣减过，幂等直接返回成功
end

local current_stock = tonumber(redis.call('GET', KEYS[1]) or '-1')
local deduct_num = tonumber(ARGV[1])

if current_stock < deduct_num then
    return -1 -- 库存不足
end

-- 扣减并记下幂等流水
redis.call('DECRBY', KEYS[1], deduct_num)
redis.call('SETEX', KEYS[2], tonumber(ARGV[3]), ARGV[1])
return 0 -- 扣减成功
```

##### 2) Java 批量聚合与防超卖落库核心逻辑

```java
@Component
public class StockDeductionAggregator {

    @Autowired
    private JdbcTemplate jdbcTemplate;

    // 内存环形无锁队列，暂存待入库流水
    private final BlockingQueue<DeductRecord> queue = new ArrayBlockingQueue<>(50000);

    @Scheduled(fixedRate = 50) // 每 50ms 聚合提交一次
    public void batchFlushToDb() {
        List<DeductRecord> batch = new ArrayList<>(500);
        queue.drainTo(batch, 500);
        if (batch.isEmpty()) return;

        // 1. 按 skuId 聚合扣减总量，大幅降低行锁争用
        Map<Long, Integer> skuDeductSum = batch.stream()
            .collect(Collectors.groupingBy(DeductRecord::getSkuId, Collectors.summingInt(DeductRecord::getNum)));

        skuDeductSum.forEach((skuId, totalDeduct) -> {
            // 2. CAS 兜底防超卖，即使缓存与 DB 发生偏差，数据库也绝不为负
            int updated = jdbcTemplate.update(
                "UPDATE tb_sku_stock SET stock = stock - ? WHERE sku_id = ? AND stock >= ?",
                totalDeduct, skuId, totalDeduct
            );
            if (updated == 0) {
                // 3. 触发补偿机制：记录严重警报，落补偿表，走对账重试或超卖熔断通知
                handleStockInconsistency(skuId, totalDeduct, batch);
            }
        });
    }
}
```

#### 5. 工程取舍（Trade-offs）
* **强一致性 vs 极高可用性**：
  若采用分布式强一致性协议（如 Raft/2PC）协同分布式事务落库，延迟将飙升至数百毫秒，无法支撑 10w QPS。系统选择“**AP 预扣 + BASE 最终一致**”，将强一致性的判定交由最前端的内存原子操作，容忍异步落库秒级延迟。
* **分桶并发度 vs 逻辑复杂度**：
  分桶越多，并发度越高；但在临界状态下（例如 Bucket 1 剩余 0，Bucket 2 剩余 1，用户购买 2 件），必须实现“跨桶借调/自动换桶轮询”，代码复杂度与网络往返开销增加。通常仅针对头部 0.1% 的大促爆品开启热点动态分桶。

---

#### 6. 故障边界与防御降级
* **脑裂/主从复制延迟引发的超卖**：
  * **边界**：当 Redis 出现异步网络分区，新主未同步到最新扣减 key，新请求打到新主造成超卖。
  * **防御**：
    1. 启用 Redis 的 `min-replicas-to-write 1` 和 `min-replicas-max-lag 2`，保证至少有 1 个从节点同步成功才允许写入；
    2. 数据库更新语句增加兜底防护：`AND stock >= totalDeduct`。一旦数据库更新失败，立即熔断后续该 SKU 的扣减流程，向前端弹窗“排队人数过多，商品已售罄”，阻断次生灾害。
* **MQ 丢失或消费者死锁导致的虚假扣减（少卖）**：
  * **边界**：Redis 已扣减但 DB 长时间未落库。
  * **防御**：异步巡检对账 Worker，按每 10 秒比对“Redis 已售出配额总数”与“DB 实际扣减总数”，若差额持续超过设定的未决窗口，向用户发起“订单超时未创建，已自动回滚配额”的补偿任务。

---

#### 7. 监控与现场排障

```
                排障核心链路监控指标拓扑
+------------------------------------------------------+
| 1. 网关层: QPS / 拒绝率 (HTTP 429) / 熔断状态        |
+--------------------------+---------------------------+
                           |
                           v
+------------------------------------------------------+
| 2. Redis 监控: Lua 执行时延 (Slowlog) / 内存使用率   |
|    重点排查: Command latency > 5ms / Client Buffer 溢出|
+--------------------------+---------------------------+
                           |
                           v
+------------------------------------------------------+
| 3. 应用层: 聚合缓冲队列水位 / 异步线程池活跃数        |
|    重点排查: queue.size() 接近容量阈值 (GC / CPU 飙升)|
+--------------------------+---------------------------+
                           |
                           v
+------------------------------------------------------+
| 4. 数据库监控: Threads_running / InnoDb Row Lock Time |
|    重点排查: Lock wait timeout / 死锁日志 (Engine Status)|
+------------------------------------------------------+
```

* **定位步骤**：
  1. **看 DB 活跃线程**：执行 `SHOW PROCESSLIST`，查看 `State` 是否普遍卡在 `Updating` 或 `Searching rows for update`。若 `Threads_running` 飙升超 100，说明合并写入失效或未分桶，行锁已雪崩。
  2. **看 Redis 慢查询与连通性**：执行 `redis-cli --latency-history` 检查 P999 网络延迟；执行 `slowlog get 10` 查看是否存在大 Key 或遍历类 Lua 脚本阻塞单线程 Reactor 循环。
  3. **查应用 JVM 内部排队**：使用 `jstack` 抓取聚合 Worker 线程堆栈，观察是否有聚合锁冲突或消费线程被下游数据库连接耗尽所挂起。

---

#### 8. 常见追问
1. **追问**：“如果用户在 Redis 扣减成功后，支付超时放弃了，库存如何回滚？”
   * **回答**：采用延迟消息或分布式定时器监听支付状态。超时未支付时，发送逆向回滚事务消息，Lua 脚本原子调用 `INCRBY` 归还指定分桶库存，并在落库流水中标记为 `CANCELLED`。
2. **追问**：“分桶后，某个分桶只剩 1 件，而用户想买 2 件，直接返回失败并不合理，怎么解决？”
   * **回答**：采用“贪心重试分配”机制。若当前分桶余额不足扣除，Lua 脚本返回其实际剩余量；客户端代码捕获后，立即降级尝试跨下一个相邻分桶继续扣减剩余缺口；若遍历全部有效分桶仍不足，才返回“库存不足”。

---

#### 推荐开源项目 (Agentic AI)
* **项目名称**：microsoft/autogen
* **URL**：https://github.com/microsoft/autogen
* **语言**：Python
* **Star 数**：61,530
* **简介**：A programming framework for agentic AI
* **最新更新时间**：2026-10-22T22:16:57Z
