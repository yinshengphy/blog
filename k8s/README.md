# K3s 公网访问

Cloudflare Tunnel 运行在 `ingress` 命名空间内，把公网 HTTPS 流量转发到 Traefik。
随后 Traefik 根据 Kubernetes Ingress 规则，把请求路由到对应服务：

```text
https://yinshengphy.cn -> cloudflared -> http://traefik.kube-system.svc.cluster.local:80 -> Ingress -> blog-web
https://www.yinshengphy.cn -> cloudflared -> http://traefik.kube-system.svc.cluster.local:80 -> Ingress -> blog-web
https://yinshengphy.cn/api/* -> cloudflared -> http://traefik.kube-system.svc.cluster.local:80 -> Ingress -> blog-rag-api
```

在 Git 之外、`ingress` 命名空间中创建 token Secret：

```bash
kubectl create namespace ingress
kubectl -n ingress create secret generic cloudflare-tunnel-token \
  --from-literal=token='<cloudflare tunnel token>'
```

然后部署：

```bash
kubectl apply -f k8s/cloudflare-tunnel.yaml
kubectl -n ingress rollout status deploy/cloudflared
```

在 Cloudflare Zero Trust 中，为这个 Tunnel 的每个 Public Hostname 配置：

- 服务类型：`HTTP`
- 服务地址：`traefik.kube-system.svc.cluster.local`
- 服务端口：`80`
- HTTP Host 头：与公网域名一致，例如 `yinshengphy.cn`
