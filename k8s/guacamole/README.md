# K3s 上的 Apache Guacamole

这套清单会把 Apache Guacamole 部署到 K3s 内，并通过现有 Cloudflare Tunnel 与 Traefik 路径对外发布。

```text
https://ssh.yinshengphy.cn
  -> Cloudflare Access
  -> Cloudflare Tunnel
  -> Traefik
  -> guacamole 服务
  -> guacd 服务
  -> host-ssh 服务
  -> host sshd:22
```

## 文件说明

- `00-namespace.yaml`：命名空间。
- `01-secrets.example.yaml`：PostgreSQL 凭据模板。
- `02-postgres.yaml`：PostgreSQL StatefulSet 和 PVC。
- `03-guacd.yaml`：guacd SSH 代理。
- `04-guacamole.yaml`：Guacamole Web 应用。
- `05-ingress.yaml`：`ssh.yinshengphy.cn` 的 Traefik Ingress。
- `06-host-ssh-service.example.yaml`：可选的 K3s 宿主机 SSH Service 别名。

## 1. 创建 Secret

不要原样应用示例 Secret。

```bash
cd /path/to/blog/k8s/guacamole
cp 01-secrets.example.yaml 01-secrets.yaml
openssl rand -base64 36
vi 01-secrets.yaml
```

## 2. 部署 Guacamole

```bash
kubectl apply -f 00-namespace.yaml
kubectl apply -f 01-secrets.yaml
kubectl apply -f 02-postgres.yaml
kubectl apply -f 03-guacd.yaml
kubectl apply -f 04-guacamole.yaml
kubectl apply -f 05-ingress.yaml
kubectl -n guacamole rollout status statefulset/postgres
kubectl -n guacamole rollout status deploy/guacd
kubectl -n guacamole rollout status deploy/guacamole
```

PostgreSQL 表结构由 `guacamole/guacamole:1.6.0` initContainer 生成，并在数据库首次启动时由官方 PostgreSQL entrypoint 导入。

## 3. 通过 Cloudflare Tunnel 暴露

如果 Tunnel 由 Cloudflare Zero Trust 管理，添加一个 Public Hostname（公网主机名）：

- 子域名：`ssh`
- 域名：`yinshengphy.cn`
- 类型：`HTTP`
- 地址：`traefik.kube-system.svc.cluster.local:80`
- HTTP Host 头：`ssh.yinshengphy.cn`

如果 Tunnel 使用本地 `cloudflared` 配置文件，添加：

```yaml
ingress:
  - hostname: ssh.yinshengphy.cn
    service: http://traefik.kube-system.svc.cluster.local:80
    originRequest:
      httpHostHeader: ssh.yinshengphy.cn
  - service: http_status:404
```

## 4. 使用 Cloudflare Access 保护

为下面的地址创建一个 Cloudflare Access 自托管应用：

```text
https://ssh.yinshengphy.cn/*
```

推荐策略：

- 只允许你自己的邮箱或可信身份提供商分组访问。
- 要求 MFA。
- 使用较短会话时长，例如 4-8 小时。
- 阻止其他所有人。

Guacamole 自带登录，但它是浏览器里的远程终端入口，所以 Access 应该作为第一道门。

## 5. 添加宿主机 SSH 目标

如果想从 Guacamole SSH 到 K3s 宿主机，又不使用 `hostNetwork`，可以创建一个指向节点 IP 的无 selector Kubernetes Service。

查找 Pod 可访问的宿主机 IP：

```bash
kubectl get nodes -o wide
```

复制并编辑示例：

```bash
cp 06-host-ssh-service.example.yaml 06-host-ssh-service.yaml
vi 06-host-ssh-service.yaml
kubectl apply -f 06-host-ssh-service.yaml
```

把 `replace-with-k3s-node-ip` 替换为节点内部 IP。

在 Guacamole 中创建新连接：

- 协议：`SSH`
- 主机名：`host-ssh.guacamole.svc.cluster.local`
- 端口：`22`
- 用户名：你的 Linux 用户名。
- 认证方式：优先使用 SSH 私钥。

## 6. 首次登录与加固

打开：

```text
https://ssh.yinshengphy.cn/
```

Guacamole 初始账号：

```text
username: guacadmin
password: guacadmin
```

立即创建真实管理员账号，然后删除或禁用 `guacadmin`。

推荐的宿主机 SSH 加固配置：

```text
PermitRootLogin no
PasswordAuthentication no
PubkeyAuthentication yes
```

修改后重载 SSH：

```bash
sudo systemctl reload ssh
```

## 7. 验证

```bash
kubectl -n guacamole get pods,svc,ingress
kubectl -n guacamole logs deploy/guacamole --tail=100
kubectl -n guacamole logs deploy/guacd --tail=100
curl -I https://ssh.yinshengphy.cn/
```

## 清理

删除 Guacamole 工作负载：

```bash
kubectl delete -f 05-ingress.yaml
kubectl delete -f 04-guacamole.yaml
kubectl delete -f 03-guacd.yaml
kubectl delete -f 02-postgres.yaml
```

确认不再需要账号、连接配置或历史记录后，再删除数据库：

```bash
kubectl -n guacamole delete pvc postgres-data-postgres-0
kubectl delete namespace guacamole
```
