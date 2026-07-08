# K3s public access

Cloudflare Tunnel runs inside the `ingress` namespace and forwards public HTTPS
traffic to Traefik. Traefik then uses Kubernetes Ingress rules to route the
request to the right service:

```text
https://yinshengphy.cn -> cloudflared -> http://traefik.kube-system.svc.cluster.local:80 -> Ingress -> blog-web
https://www.yinshengphy.cn -> cloudflared -> http://traefik.kube-system.svc.cluster.local:80 -> Ingress -> blog-web
https://yinshengphy.cn/api/* -> cloudflared -> http://traefik.kube-system.svc.cluster.local:80 -> Ingress -> blog-rag-api
```

Create the token secret outside Git in the `ingress` namespace:

```bash
kubectl create namespace ingress
kubectl -n ingress create secret generic cloudflare-tunnel-token \
  --from-literal=token='<cloudflare tunnel token>'
```

Then deploy:

```bash
kubectl apply -f k8s/cloudflare-tunnel.yaml
kubectl -n ingress rollout status deploy/cloudflared
```

In Cloudflare Zero Trust, configure each public hostname on this tunnel with:

- Service type: `HTTP`
- Service URL: `traefik.kube-system.svc.cluster.local`
- Service port: `80`
- HTTP Host Header: same as the public hostname, for example `yinshengphy.cn`
