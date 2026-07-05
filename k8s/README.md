# K3s public access

Cloudflare Tunnel runs inside the `blog` namespace and forwards public HTTPS
traffic to the in-cluster blog service:

```text
https://yinshengphy.cn -> cloudflared -> http://blog-web.blog.svc.cluster.local:80
https://www.yinshengphy.cn -> cloudflared -> http://blog-web.blog.svc.cluster.local:80
```

Create the token secret outside Git:

```bash
kubectl -n blog create secret generic cloudflare-tunnel-token \
  --from-literal=token='<cloudflare tunnel token>'
```

Then deploy:

```bash
kubectl apply -f k8s/cloudflare-tunnel.yaml
kubectl -n blog rollout status deploy/cloudflared
```
