---
title: 热备mysql部署方案总结
toc: true
thumbnail: /assets/posts/mysql/mysql-logo.png
date: 2020-10-20 10:15:54
tags:
- MySQL
- 分布式
categories:
- 教程
---
近一段时间的工作都是在部署mysql，主要涉及到mysql的主从复制，及配合keepalived实现mysql集群的高可用，这里是学习记录的总结。


<!-- more -->

# 前言

## 说明

为方便起见，这里我直接采用docker创建容器作演示用，软件版本如下

|  名称   | 版本  |
|  ----  | ----  |
| docker  | 19.03.5 |
| mysql  | 5.7 |

> 由于数据库作为一种IO密集应用，事实上并不适合用容器化实现，建议在生产环境单独为数据库单独分配服务器，这里仅提供环境用以说明原理

下面步骤将搭建互为热备的两台数据库，同时，借助keepalived来实现高可用
## 什么是 MYSQL Replication
在 MYSQL 中，复制操作是异步进⾏的，slaves 服务器不需要持续地保持连接接收 master 服务器的数据。MYSQL ⽀持⼀台主服务器同时向多台从服务器进⾏复制操作，从服务器同时可以作为其他从服务器的主服务器，如果 MYSQL 主服务器访问量⽐较⼤，可以通过复制数据，然后在从服务器上进⾏査询操作，从⽽降低主服务器的访问压⼒，同时从服务器作为主服务器的备份，可以避免主服务器因为故障数据丢失的问题。
**Replication** 可以实现将数据从⼀台数据库服务器（master）复制到⼀到多台数据库服务器（slave）。默认情况下，属于异步复制。因此⽆需维持⻓连接。
## Mysql Replication原理
### MySQL Replication功能的意义
 互联⽹应⽤系统中，⼀个设计恰当的WEB应⽤服务器在绝⼤多数情况下都是⽆状态的（Session除外，Session共享可通过WEB容器解决），故WEB应⽤服务器的扩展和集群相对简单。但数据库的集群和复制就不那么容易了。各个数据库⼚商也⼀直在努⼒使⾃⼰的产品能够像WEB应⽤服务器⼀样能够⽅便的复制和集群。
**MySQLReplication**的出现使我们能够⾮常⽅便将某⼀数据库中的数据复制到多台服务器中，从⽽实现数据备份、主从热备、数据库集群等功能。这样有效的提⾼了数据库的处理能⼒，提⾼了数据安全性等。
### MySQLReplication实现原理
MySQL的复制（replication）是⼀个异步的复制，从⼀个MySQLinstace（称之为Master）复制到另⼀个MySQLinstance（称之Slave）。整个复制操作主要由三个进程完成的，其中两个进程在Slave（Sql进程和IO进程），另外⼀个进程在Master（IO进程）上。要实施复制，⾸先必须打开Master端的binarylog（bin-log）功，否则⽆法实现。因为整个复制过程实际上就是Slave从Master端获取该⽇志然后再在⾃⼰身上完全顺序的执⾏⽇志中所记录的各种操作。复制的基本过程如下：
1. Slave上⾯的IO进程连接上Master，并请求从指定⽇志⽂件的指定位置（或者从最开始的⽇志）之后的⽇志内容；
2. Master接收到来⾃Slave的IO进程的请求后，通过负责复制的IO进程根据请求信息读取指定⽇志指定位置之后的⽇志信息，返回给Slave的IO进程。返回信息中除了⽇志所包含的信息之外，还包括本次返回的信息已经到Master端的bin-log⽂件的名称以及bin-log的位置；
3. Slave的IO进程接收到信息后，将接收到的⽇志内容依次添加到Slave端的relay-log⽂件的最末端，并将读取到的Master端的bin-log的⽂件名和位置记录到master-info⽂件中，以便在下⼀次读取的时候能够清楚的告诉Master“我需要从某个bin-log的某个位置开始往后的⽇志内容，请发给我”；
4. Slave的Sql进程检测到relay-log中新增加了内容后，会⻢上解析relay-log的内容成为在Master端真实执⾏时候的那些可执⾏的内容，并在⾃身执⾏。

MYSQL 数据库复制操作⼤致可以分成三个步骤：
主服务器将数据的改变记录到⼆进制⽇志（binary log）中。
从服务器将主服务器的 binary log events 复制到它的中继⽇志（(relaylog）中。
从服务器重做中继⽇志中的事件，将数据的改变与从服务器保持同步。⾸先，主服务器会记录⼆进制⽇志，每个事务更新数据完成之前，主服务器将这些操作的信息记录在⼆进制⽇志⾥⾯，在事件写⼊⼆进制⽇志完成后，主服务器通知存储引擎提交事务。
1. slave 上⾯的 0 进程连接上 Master，并发出⽇志请求，Master 接收到来自Slave 的 O 进程的请求后，通过负责复制的 O 进程根据请求信息读取与制定⽇志指定位置之后的⽇志信息，返回给 Slave 的 IO 进程。返回信息中除了⽇志所包含的信息之外，还包括本次返回的信息已经到 Master 端的bin-log ⽂件的名称以及 bin-log的位置。
2. Slave的I/O进程接收到信息后，将接收到的⽇志内容依次添加到 Slave 端的 relay-log ⽂件的最末端，并将读取到 Master 端的 bin-log 的⽂件名和位置记录到 master-info ⽂件中。
3. Slave 的 SQL 进程检测到 relay-log 中新增加了内容后，会⻢上解析relay-log 的内容成为在 Master 端真实执⾏时候的那些可执⾏的内容，并在⾃身执⾏。MYSQL 复制环境 909%以上都是⼀个 Master 帯⼀个或者多个 Slave 的架构模式。如果 master和 slave 的压⼒不是太⼤的话，异步复制的延时⼀般都很少。尤其是 slave 端的复制⽅式改成两个进程处理之后，更是减⼩了 slave 端的延时

# 安装步骤

## 创建容器

直接在安装了docker的服务器上运行如下命令创建所需要的容器


```shell script
docker run -p 3307:3306 -e \          #占用宿主机端口3307
 MYSQL_ROOT_PASSWORD=root  \          #设置root密码为root
--name mysql_1 -d mysql:5.7 \         #指定容器名称，后台启动，指定镜像版本
--character-set-server=utf8mb4 \      #设置字符集
--lower_case_table_names=1 \          #忽略大小写
--log-bin=/var/lib/mysql/mysql-bin \  #设置binlog文件存储位置
--server-id=1                         #设置server-id，避免主从复制无限循环

docker run -p 3308:3306 -e \
 MYSQL_ROOT_PASSWORD=root  \
--name mysql_2 -d mysql:5.7 \
--character-set-server=utf8mb4 \
--lower_case_table_names=1 \
--log-bin=/var/lib/mysql/mysql-bin \
--server-id=2
```

完成后可查看效果

```shell script
[root@xxxx ~] docker ps |grep mysql
xxxxx    mysql:5.7    "docker-entrypoint.s…"   5 hours ago Up 5 hours   33060/tcp, 0.0.0.0:3308->3306/tcp mysql_2
xxxxx    mysql:5.7    "docker-entrypoint.s…"   5 hours ago Up 5 hours   33060/tcp, 0.0.0.0:3307->3306/tcp mysql_1
```

## 配置主从复制

```mysql
# mysql_2执行如下
CHANGE MASTER TO
master_host='xx.xx.xx.xx', #宿主机ip
master_port=3308,
master_user='root',
master_password='root';

start slave;

# mysql_1执行如下
CHANGE MASTER TO
master_host='xx.xx.xx.xx', #宿主机ip
master_port=3307,
master_user='root',
master_password='root';

start slave;
```
分别查看两台服务器主从复制状态

```shell script
SHOW SLAVE STATUS;
```
如果	Slave_SQL_Running及Slave_SQL_Running字段均为 Yes 则证明配置正确
