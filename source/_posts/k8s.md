---
title: 容器化部署方案总结
toc: true
date: 2020-08-15 22:41:38
thumbnail: /assets/posts/k8s/Kubernetes-logo.png
tags:
- 容器化
- docker
- k8s
categories:
- 教程
---
最近一段时间都在研究**容器编排系统**（**Container Orchestration**），这里作一个学习记录的总结。

<!-- more -->

# 前言

## 说明
 容器化作为目前最新的虚拟化技术解决方案，相较于传统虚拟机有非常多的优点，我的总结就是更快，占用资源更少，及更好移植。在原理的实现上，虚拟机则是虚拟化硬件，因此容器更具有便携性、高效地利用服务器。 容器更多的用于表示 软件的一个标准化单元。由于容器的标准化，因此它可以无视基础设施（Infrastructure）的差异，部署到任何一个地方。配合**kubernetes**容器编排系统，可以为我们的应用容器实现服务发现，负载均衡，缺陷自修复，资源管理等等。
 
 全文均为围绕这两个工具及其相关组件展开，以本站作为一个参照例，详细介绍一个简单应用容器部署过程。
 
## 准备工作
需要一台或多台Linux公网服务器
>因为kubernetes作为分布式容器编排系统，如果在生产环境是会有多台服务器集群来提高容器虚拟化能力的，但是作为学习用途的话，用一台也可以达到效果

操作系统版本及配置信息（演示为例）：
CentOS Linux release 7.6.1810 (Core) 2核 8G

需要基本的linux操作基础

# 开始

各组件版本说明：

|  名称   | 版本  |
|  ----  | ----  |
| docker  | 19.03.5 |
| kubernetes  | v1.18.2 |
| kubernetes-dashboard  | v2.0.0-beta8 |
| helm  | v3.2.0 |
| drone  | 1.9.0 |

下面从各个组件分别开始部署流程

## docker

docker官网：<https://www.docker.com/>

docker是什么，及与传统虚拟机区别，及它的优缺点，上文有所提及，更细节的部分，请各位自行查阅资料，这里仅对linux安装过程展开

```shell script
#添加源，选用阿里爸爸家的
yum-config-manager --add-repo http://mirrors.aliyun.com/docker-ce/linux/centos/docker-ce.repo

#生成包缓存
yum makecache fast
  
# 安装最新稳定版本的docker
yum install -y docker-ce
```

至此，安装步骤结束，接下来是配置及启动和设置自启动

同样选择阿里云镜像仓库，这里需要各位自己去申请一个自己的专属镜像仓库
地址：<https://cr.console.aliyun.com/cn-hangzhou/instances/mirrors>

大概长这样：https://xxxxx.mirror.aliyuncs.com

下面开始配置docker镜像仓库

```shell script
# 配置镜像加速器(注意要把下面的网址换成自己上面申请的)
mkdir -p /etc/docker

tee /etc/docker/daemon.json <<-'EOF'
{
  "registry-mirrors": ["https://xxxxx.mirror.aliyuncs.com"]
}
EOF

# 启动docker引擎并设置开机启动
systemctl start docker
systemctl enable docker
```
好了，如果没有报错，docker就已经安装及启动成功了

因为k8s的出现，我们已经不用docker作容器编排了（如docker-compose等），docker现在仅作为镜像的管理工具，及容器化的实现，但是，dockerfile的编写技巧仍然需要我们掌握，因为，docker
就是利用dockerfile来实现自定义镜像的，这里给出我觉得比较好的dockerfile总结<https://yeasy.gitbook.io/docker_practice/image/dockerfile/>

## kubernetes

kubernetes官网：<https://kubernetes.io/>

其实kubernetes正常情况下，安装非常容易，但是由于**GFW**的原因，导致国内访问不了国外很多的网站，导致我们缺失相关镜像，这里我们主要的工作主要集中在缺失镜像的替换上。

```shell script
#yum添加阿里云资源库
cat <<EOF > /etc/yum.repos.d/kubernetes.repo
[kubernetes]
name=Kubernetes
baseurl=https://mirrors.aliyun.com/kubernetes/yum/repos/kubernetes-el7-x86_64
enabled=1
gpgcheck=0
EOF

#安装epel-release自动配置yum
yum -y install epel-release

#安装kubectl，kubelet，kubeadm
yum -y install kubectl-1.18.2 kubelet-1.18.2 kubeadm-1.18.2

#启动kubelet，并设置开机自启
systemctl enable kubelet && systemctl start kubelet
```

此时，安装已完成，下面就是下载缺失的镜像并完成初始化，具体的思路就是，获取依赖镜像的列表，从阿里云源下载依赖的镜像，重新**tag**镜像至k8s.gcr.io
>**tag**是docker的概念，详细参考官方文档<https://docs.docker.com/engine/reference/commandline/tag/>

```shell script
#查询缺失的镜像并从阿里云下载
kubeadm config images list 2>/dev/null |sed -e 's/^/docker pull /g' -e 's#k8s.gcr.io#registry.cn-hangzhou.aliyuncs
.com/google_containers#g' |bash -x

#为下载好的镜像重新打标签
docker images |grep registry.cn-hangzhou.aliyuncs.com/google_containers |awk '{print "docker tag ",$1":"$2,$1":"$2}' |sed -e 's#registry.cn-hangzhou.aliyuncs.com/google_containers#k8s.gcr.io#2' |bash -x

#初始化
kubeadm init


#复制配置文件
mkdir -p $HOME/.kube
sudo cp -i /etc/kubernetes/admin.conf $HOME/.kube/config
sudo chown $(id -u):$(id -g) $HOME/.kube/config
```

至此，安装部分全部结束，可以用如下命令查看当前集群中初始化创建的容器组
```shell script
kubectl get pods -A

NAMESPACE              NAME                                         READY   STATUS    RESTARTS   AGE
kube-system            coredns-546565776c-6lwmr                     1/1     Running   1          1h
kube-system            coredns-546565776c-6tb7r                     1/1     Running   1          1h
kube-system            etcd-jd                                      1/1     Running   1          1h
kube-system            kube-apiserver-jd                            1/1     Running   1          1h
kube-system            kube-controller-manager-jd                   1/1     Running   2          1h
kube-system            kube-proxy-75dd5                             1/1     Running   2          1h
kube-system            kube-scheduler-jd                            1/1     Running   2          1h
```
可以观察到初始化创建了dns，apiserver，proxy等等一些容器组

## traefik

下面开始安装我们的第一个，也是我认为最重要之一的组件**traefik**

官网：<https://docs.traefik.io/>
  
![](/assets/posts/k8s/2.3_1_traefik-architecture.png)

尽管k8s也提供了**ingress**路由组件，但是我觉得没有**traefik**好用

下面介绍**traefik**，**traefik**是一种边缘路由器，公开了从集群外部到集群内服务的 **HTTP** 和 **HTTPS** 路由。 流量路由由 **IngressRoute** 资源上定义的规则控制。

**traefik可以分发流量**
 
如上图所示，**traefik**接受了来自 **API.DOMAIN.COM** ,**DOMAIN.COM/WEB**等流量，按照配置好的路由规则分别将请求流量路由到**k8s**集群中不同的**service**处理，也就是说，集群只要公布**80**和**443**两个端口，就可以处理任意多的应用的请求，只需要配置好路由规则，以目前这台服务器为例，不仅支持了本站前端页面的访问（**yinshengphy.cn**），也提供了**k8s仪表盘**的访问能力（后面介绍），也提供了traefik自己的控制台操作等。
 
**traefik可以自动签发证书**
借助对**Let's Encrypt**配置，可以自动签发对指定域名的证书，而无需手动一个一个申请
**Let's Encrypt**官网：https://letsencrypt.org/
>感谢为爱发电的开源组织，让我们可以白嫖到多数浏览器信任的证书

**traefik支持TLS终止** 
相关概念可参照：[维基百科](https://en.wikipedia.org/wiki/TLS_termination_proxy)
![](/assets/posts/k8s/2.3_2_TLS_termination_proxy.png)
 
这样，我们集群内部可以仅适用http来相互传输数据，但是如果对集群外部发送/接受数据，traefik会自动对数据包加密(**HTTPS**)

还有更多非常有用的特性&功能，大家可以到官网上学习

>这里我给出我的配置供大家参考:
><https://github.com/yinshengphy/k8s_setting/tree/master/traefik/v2.2>

 ```shell script
#命令
#密码等关键信息已用xxxxxx代替，请大家自行更改替换
kubectl apply -f .
#下同，不再赘述
```

 
## kubernetes-dashboard

尽管我们可以用**kubectl**工具来实现管理集群的任何操作，但是我们还是希望有一个可视化界面来直接查看或修改我们集群的信息，类似于这样:

![](/assets/posts/k8s/2.4_1_k8s_dashboard.png)

可以非常直观的看到集群运行状况，甚至在近期更新的**k8s仪表盘**中，我们还可以观察到集群的硬件资源消耗情况（**CPU**，**MEM**等）

>参考配置:
><https://github.com/yinshengphy/k8s_setting/tree/master/kube-dashboard/v2>

## nfs
一般情况下，集群的计算和存储都是区分开的，以上的部分都是部署的计算相关的组件，下面我们要部署存储相关的组件，这里我们选用的是nfs，当然，k8s也支持非常多的第三方存储
>官方支持列表：
>https://kubernetes.io/zh/docs/concepts/storage/storage-classes/

本节内容借鉴了<https://www.qikqiak.com/post/kubernetes-persistent-volume1/>

分为客户端和服务器两个部分，如果服务器资源比较拮据，安装在同一台服务器上也不是不可以。

```shell script
#以下内容在服务上安装
#共享目录权限设置
chmod 755 /data/k8s/

#配置nfs xx表示允许访问的服务器ip
echo "/data/k8s  xx.xx.xx.xx(rw,sync,no_root_squash)">/etc/exports

#启动rpcbind
systemctl start rpcbind.service
systemctl enable rpcbind

#启动nfs服务
systemctl start nfs.service
systemctl enable nfs

#以下内容在客户端安装
#安装nfs
yum -y install nfs-utils rpcbind

#启动rpcbind
systemctl start rpcbind.service
systemctl enable rpcbind

#启动nfs服务
systemctl start nfs.service
systemctl enable nfs
```
下面就是配置k8s对nfs的支持
参考配置：
<https://github.com/yinshengphy/k8s_setting/tree/master/nfs>

## drone
下面介绍CI/CD工具

尽管有很多持续集成工具，例如大名鼎鼎的**Jenkins**，被广泛使用且网上有诸多教程，但是我还是想选择一个和容器化更加契合的工具，另外，**Jenkins**虽然功能全面，但是却太笨重了，除此之外还有一个最重要的原因，就是我不能用代码的方式来定义&实现我的构建[everything-as-code](https://openpracticelibrary.com/practice/everything-as-code/) ,我必须按部就班的一个一个点击交互来配置我的构建，这对我来说是不能容忍的。

另外，以本站为例的代码也已开源在同性交友社区，涵盖网站源码，docker配置，及drone配置等。
<https://github.com/yinshengphy/blog>

走过路过，点个星呗^_^


>参考配置：
><https://github.com/yinshengphy/k8s_setting/tree/master/drone>

全文完。
