---
title: "技术深潜｜2026年11月20日"
date: "2026-11-20"
description: "围绕Java 基础与核心机制的生产级技术推演、排障思路与 AI 应用项目推荐。"
tags: ["Java 基础与核心机制", "Java", "系统设计", "AI 工程"]
categories: ["每日技术推送"]
---

【高级面试题｜2026-11-20】
【今日方向】：Java 基础与核心机制

**场景与问题**

你负责一个 Java 17 多租户订单服务：8,000 QPS，Tomcat 接收请求后提交到固定大小为 200 的业务线程池；请求上下文包括 `tenantId`、用户权限和 `traceId`，团队通过 `ThreadLocal` 和 `MDC` 传递。

近期出现：

- 服务运行数小时后堆内存持续上涨，Full GC 频繁，最终 OOM；
- 偶发出现日志 `traceId` 串请求；
- 极少量请求读取到上一租户的权限，触发安全告警；
- 不能立即重启，不能简单扩大堆，也不能把线程池改成“每请求一个线程”；
- 需要保持异步处理和现有 P99 延迟目标。

请说明根因、如何在线止血和长期改造；同时解释 `ThreadLocalMap`、线程池复用、`CompletableFuture` 异步链路之间的关系。

**一句话结论：**问题本质是把请求级状态错误地绑定到可复用线程，且未在任务边界清理或显式传播，导致上下文污染与 `ThreadLocal` 值滞留。

**核心原理**

1. `ThreadLocal` 数据实际存放在当前线程的 `ThreadLocalMap`，不是 `ThreadLocal` 对象本身。
2. `ThreadLocalMap` 的 key 是弱引用，value 是强引用；key 被 GC 后，value 不会立刻消失，只能在后续访问时被动清理。
3. 在线程池中，工作线程长期存活并反复执行任务。若请求结束不 `remove()`，旧值就可能被下一请求读取。
4. `InheritableThreadLocal` 只在线程创建时复制父线程值，不会在任务提交时传播；在线程池中通常既不可靠又容易造成错误继承。
5. `CompletableFuture` 默认可能使用公共 ForkJoinPool，异步阶段不一定运行在提交任务的线程，因此普通 `ThreadLocal` 不会自动传播。
6. `MDC` 通常也是基于 `ThreadLocal`，所以“日志串请求”和业务上下文污染往往是同一个生命周期问题。

必须区分两类故障：  
- **污染**：线程复用后未清理，下一任务读到旧上下文；  
- **丢失**：任务切换线程后没有显式传递上下文。

**关键实现与工程取舍**

在线止血优先做三件事：

- 在请求入口创建不可变的 `RequestContext`；
- 在线程池任务外层统一 `set`，并在 `finally` 中恢复或 `remove`；
- 禁止业务代码直接读写多个散落的 `ThreadLocal`，统一通过上下文访问器。

关键代码：

```java
final class RequestContext {
    final String tenantId;
    final String traceId;
    final Set<String> permissions;

    RequestContext(String tenantId, String traceId, Set<String> permissions) {
        this.tenantId = tenantId;
        this.traceId = traceId;
        this.permissions = Set.copyOf(permissions);
    }
}

final class ContextHolder {
    static final ThreadLocal<RequestContext> LOCAL = new ThreadLocal<>();

    static Runnable wrap(Runnable task, RequestContext captured) {
        return () -> {
            RequestContext previous = LOCAL.get();
            try {
                LOCAL.set(captured);
                task.run();
            } finally {
                if (previous == null) LOCAL.remove();
                else LOCAL.set(previous);
            }
        };
    }
}
```

提交任务时捕获上下文：

```java
RequestContext ctx = ContextHolder.LOCAL.get();
executor.execute(ContextHolder.wrap(this::processOrder, ctx));
```

若使用 `CompletableFuture`，显式指定执行器，并在每个异步边界传播上下文：

```java
RequestContext ctx = ContextHolder.LOCAL.get();

CompletableFuture
    .supplyAsync(ContextHolder.wrapSupplier(() -> loadOrder(), ctx), executor)
    .thenApplyAsync(ContextHolder.wrapFunction(this::checkPermission, ctx), executor);
```

生产实现中应提供通用的 `wrapSupplier`、`wrapFunction`、`wrapCallable`，并同时处理 MDC。更推荐让核心业务方法显式接收 `RequestContext`，ThreadLocal 只作为日志和兼容层。

**工程取舍**

- 显式参数：可测试、边界清晰，但改造面较大；
- ThreadLocal：改造快，但隐式依赖多，容易跨线程丢失；
- 自动上下文传播组件：接入方便，但必须验证线程池、定时任务、重试和回调边界；
- 不应传播完整用户对象、请求体或大集合，只传播必要且不可变的标识；
- `remove()` 比“覆盖为空对象”更稳妥，避免对象和引用链继续存活。

**故障边界、监控与排障**

不能只在 Controller 返回处清理：异常、超时、异步提交失败、重试、定时任务都可能绕过正常返回路径。线程池拒绝任务时，也必须保证捕获的上下文不会被额外缓存。

排查步骤：

1. 先看 Full GC、Old Gen、堆外内存、线程数和线程池队列；确认是否存在“运行数小时后增长”的趋势。
2. 使用 `jcmd <pid> GC.class_histogram` 观察请求对象、权限集合、MDC 值是否持续增长；必要时抓两次堆转储做对象增长对比。
3. 用 MAT 查看从 `Thread -> threadLocals -> ThreadLocalMap -> value` 的引用链，重点检查工作线程持有的大对象。
4. 用 JFR、线程池指标和日志关联 `traceId`，确认异步阶段是否切换到其他执行器。
5. 对租户上下文做安全审计：日志中只打印脱敏后的 tenant 标识，发现串租户时立即熔断相关功能或拒绝无上下文请求。
6. 监控线程池活跃数、队列长度、拒绝数、任务等待时间、上下文缺失率，以及请求完成后 ThreadLocal 清理失败计数。

**常见追问**

- 为什么弱引用 key 被回收后仍会泄漏？  
  因为 value 仍是强引用，只有后续 `ThreadLocalMap` 操作触发过期槽位清理。
- `InheritableThreadLocal` 能解决异步传播吗？  
  不能可靠解决线程池任务传播；它绑定线程创建时机，不是任务提交时机。
- `remove()` 放在任务开始还是结束？  
  结束必须执行；开始也可先清理，防御线程被其他代码污染。
- 换虚拟线程是否彻底解决？  
  不能。它降低平台线程复用污染，但上下文仍可能过大、生命周期错误，异步切换仍需明确传播。
- 如何验证修复？  
  做长时间压测、随机异常和超时注入，校验租户隔离、上下文缺失率、堆增长曲线和 Full GC 频率。

**AI 应用层 GitHub 项目推荐**

[langgenius/dify](https://github.com/langgenius/dify)：用于构建 Agentic workflows、RAG pipelines，并支持丰富的 AI 模型与工具协作；Python，⭐161,519。
