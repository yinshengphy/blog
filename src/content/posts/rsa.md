---
title: RSA 加密原理
date: 2020-03-21 13:21:57
description: 从密钥分发问题讲起，用一个完整的小例子推导 RSA 的公钥、私钥、欧拉函数、模逆元和加解密原理。
thumbnail: /assets/posts/rsa/rsa-logo.jpg
tags:
  - RSA
  - 密码学
  - 数论
categories:
  - 随笔
---

RSA 是最经典的非对称密码算法之一。它的价值不在于“把所有数据都直接用 RSA 加密”，而在于解决了一个长期困扰密码学的问题：**如何在不安全的网络中，让双方安全地建立通信所需的密钥或完成身份认证**。

在真实系统里，例如 HTTPS/TLS，通常不会直接用 RSA 加密整段业务数据，而是采用“非对称密码 + 对称密码”的混合方案：非对称密码负责密钥协商、证书认证或数字签名；真正大量传输的数据，仍然交给 AES、ChaCha20 这类对称加密算法处理。

本文只讨论 RSA 的数学核心：公钥、私钥是如何生成的？为什么用公钥加密后，只有私钥能解开？

## 一、RSA 解决的核心问题

先看一个传统的对称加密场景。

张三和李四约定同一个密钥：

- 李四用这个密钥加密消息；
- 张三用同一个密钥解密消息。

问题在于：**这个密钥本身怎么安全地交给对方？**

如果他们要通过网络传递密钥，而网络又可能被监听，那么密钥一旦泄露，后面的通信就都不安全了。这就是对称加密的“密钥分发问题”。

RSA 的思路是使用一对不同的密钥：

| 密钥 | 是否公开 | 作用 |
| --- | --- | --- |
| 公钥 | 可以公开 | 加密消息，或验证签名 |
| 私钥 | 必须保密 | 解密消息，或生成签名 |

以“加密通信”为例：

1. 张三生成一对密钥：公钥和私钥；
2. 张三把公钥公开给李四；
3. 李四用张三的公钥加密消息；
4. 张三收到密文后，用自己的私钥解密；
5. 即使别人截获了公钥和密文，也很难推出明文。

这就是非对称加密的基本思想。

## 二、RSA 的基本公式

RSA 的加密和解密可以抽象成下面两个公式。

加密：

$$
C \equiv M^e \pmod N
$$

解密：

$$
M \equiv C^d \pmod N
$$

其中：

| 符号 | 含义 |
| --- | --- |
| $M$ | 明文对应的数字 |
| $C$ | 密文对应的数字 |
| $N$ | 两个大质数的乘积 |
| $e$ | 公钥指数 |
| $d$ | 私钥指数 |
| $(e, N)$ | 公钥 |
| $(d, N)$ | 私钥 |

注意：这里的 $M$ 必须先被转换成数字，并且需要满足 $0 \le M < N$。真实系统不会直接使用这种“裸 RSA”（Textbook RSA），而会搭配安全填充方案，例如用于加密的 OAEP，或者用于签名的 PSS。

## 三、RSA 需要的数论基础

如果只想知道 RSA 怎么用，可以直接跳到后面的示例。但如果想理解“为什么能解密回来”，需要先了解几个概念。

### 1. 互质

如果两个正整数除了 1 以外没有其他公因子，就称它们互质，记作：

$$
\gcd(a, b) = 1
$$

例如 15 和 32 互质，因为它们没有共同的质因子。

互质并不要求两个数本身都是质数。比如 8 和 15 都不是质数，但它们互质。

### 2. 欧拉函数

欧拉函数记作 $\varphi(n)$，表示在 $1$ 到 $n$ 之间，有多少个正整数与 $n$ 互质。

对于 $n > 1$，也可以理解为：

> 小于 $n$ 且与 $n$ 互质的正整数个数。

如果一个整数 $n$ 的质因数分解为：

$$
n = p_1^{a_1}p_2^{a_2}\cdots p_r^{a_r}
$$

那么欧拉函数可以计算为：

$$
\varphi(n)=n\left(1-\frac{1}{p_1}\right)\left(1-\frac{1}{p_2}\right)\cdots\left(1-\frac{1}{p_r}\right)
$$

RSA 中最常见的是：

$$
N = pq
$$

其中 $p$ 和 $q$ 是两个不同的质数。因此：

$$
\varphi(N)=\varphi(pq)=(p-1)(q-1)
$$

这是 RSA 密钥生成的关键一步。

### 3. 欧拉定理

如果 $a$ 和 $n$ 互质，则有：

$$
a^{\varphi(n)} \equiv 1 \pmod n
$$

这就是欧拉定理。

如果 $n$ 本身是质数，那么：

$$
\varphi(n)=n-1
$$

于是欧拉定理可以写成：

$$
a^{n-1} \equiv 1 \pmod n
$$

这就是费马小定理。

RSA 解密公式能成立，核心就依赖欧拉定理和中国剩余定理。

### 4. 模逆元

如果整数 $a$ 和 $m$ 互质，那么一定存在一个整数 $x$，使得：

$$
ax \equiv 1 \pmod m
$$

这个 $x$ 就叫做 $a$ 关于模 $m$ 的逆元，也叫模逆元。

RSA 中的私钥指数 $d$，就是 $e$ 关于 $\varphi(N)$ 的模逆元：

$$
ed \equiv 1 \pmod {\varphi(N)}
$$

换句话说，一定存在整数 $k$，使得：

$$
ed = 1 + k\varphi(N)
$$

这个式子后面会用来解释 RSA 为什么能解密成功。

## 四、RSA 密钥如何生成

RSA 密钥生成可以拆成 5 步。

### 第 1 步：选择两个不同的大质数

选择两个不同的质数：

$$
p, q
$$

为了方便演示，本文使用两个很小的质数：

$$
p = 41, \quad q = 71
$$

真实系统里不能使用这么小的数。工程上通常至少使用 2048 位 RSA；如果希望获得更高安全强度，常见选择是 3072 位或 4096 位。

### 第 2 步：计算 $N$

$$
N = pq = 41 \times 71 = 2911
$$

$N$ 会同时出现在公钥和私钥中。

### 第 3 步：计算 $\varphi(N)$

因为 $p$ 和 $q$ 都是质数：

$$
\varphi(N)=(p-1)(q-1)
$$

代入数字：

$$
\varphi(2911)=40\times70=2800
$$

### 第 4 步：选择公钥指数 $e$

选择一个整数 $e$，需要满足：

$$
1 < e < \varphi(N)
$$

并且：

$$
\gcd(e, \varphi(N)) = 1
$$

也就是说，$e$ 必须和 $\varphi(N)$ 互质。

为了演示，选：

$$
e = 51
$$

实际工程中常见的公钥指数是：

$$
e = 65537
$$

因为它既满足安全要求，又有较好的计算性能。

### 第 5 步：计算私钥指数 $d$

$d$ 需要满足：

$$
ed \equiv 1 \pmod {\varphi(N)}
$$

也就是：

$$
51d \equiv 1 \pmod {2800}
$$

用扩展欧几里得算法可以求出：

$$
d = 2251
$$

验证一下：

$$
51 \times 2251 = 114801
$$

而：

$$
114801 \bmod 2800 = 1
$$

所以 $d = 2251$ 是合法的私钥指数。

最终得到：

| 类型 | 值 |
| --- | --- |
| 公钥 | $(e, N) = (51, 2911)$ |
| 私钥 | $(d, N) = (2251, 2911)$ |

## 五、用这个密钥加密一个字符

假设李四要给张三发送字母 `U`。

`U` 的 ASCII 码是：

$$
M = 85
$$

### 1. 加密

李四使用张三的公钥 $(51, 2911)$ 加密：

$$
C \equiv 85^{51} \pmod {2911}
$$

计算结果是：

$$
C = 724
$$

所以密文是 `724`。

### 2. 解密

张三使用自己的私钥 $(2251, 2911)$ 解密：

$$
M \equiv 724^{2251} \pmod {2911}
$$

计算结果是：

$$
M = 85
$$

再把 `85` 转回 ASCII 字符，就得到原文 `U`。

## 六、为什么解密能还原明文

前面我们选择 $d$ 的时候，满足：

$$
ed \equiv 1 \pmod {\varphi(N)}
$$

所以一定存在整数 $k$：

$$
ed = 1 + k\varphi(N)
$$

解密时：

$$
C^d \equiv (M^e)^d \equiv M^{ed} \pmod N
$$

代入 $ed = 1 + k\varphi(N)$：

$$
M^{ed}=M^{1+k\varphi(N)}=M\left(M^{\varphi(N)}\right)^k
$$

如果 $M$ 与 $N$ 互质，根据欧拉定理：

$$
M^{\varphi(N)} \equiv 1 \pmod N
$$

于是：

$$
M\left(M^{\varphi(N)}\right)^k \equiv M \times 1^k \equiv M \pmod N
$$

这说明：

$$
C^d \equiv M \pmod N
$$

也就是说，用公钥加密后的密文，确实可以用对应的私钥解回原文。

如果 $M$ 与 $N$ 不互质，严格证明需要借助中国剩余定理，分别在模 $p$ 和模 $q$ 的意义下证明，再合并回模 $N$。结论仍然成立。

## 七、如何用程序验证

大整数不能直接用普通整数的 `pow` 计算，否则很容易溢出或性能极差。Java 里应该使用 `BigInteger#modPow`。

```java
import java.math.BigInteger;

public class RsaDemo {
    public static void main(String[] args) {
        BigInteger n = BigInteger.valueOf(2911);
        BigInteger e = BigInteger.valueOf(51);
        BigInteger d = BigInteger.valueOf(2251);

        BigInteger message = BigInteger.valueOf(85);

        BigInteger cipher = message.modPow(e, n);
        BigInteger plain = cipher.modPow(d, n);

        System.out.println(cipher); // 724
        System.out.println(plain);  // 85
    }
}
```

如果要计算模逆元，可以直接使用 `BigInteger#modInverse`：

```java
import java.math.BigInteger;

public class ModInverseDemo {
    public static void main(String[] args) {
        BigInteger e = BigInteger.valueOf(51);
        BigInteger phi = BigInteger.valueOf(2800);

        BigInteger d = e.modInverse(phi);

        System.out.println(d); // 2251
    }
}
```

如果想手写扩展欧几里得算法，可以这样写：

```java
public class ExtendedGcdDemo {
    public static void main(String[] args) {
        long e = 51;
        long phi = 2800;

        long d = modInverse(e, phi);

        System.out.println(d); // 2251
    }

    static long modInverse(long a, long m) {
        long[] result = extendedGcd(a, m);
        long gcd = result[0];
        long x = result[1];

        if (gcd != 1) {
            throw new IllegalArgumentException("a 和 m 不互质，不存在模逆元");
        }

        return (x % m + m) % m;
    }

    static long[] extendedGcd(long a, long b) {
        if (b == 0) {
            return new long[] {a, 1, 0};
        }

        long[] next = extendedGcd(b, a % b);
        long gcd = next[0];
        long x1 = next[1];
        long y1 = next[2];

        long x = y1;
        long y = x1 - (a / b) * y1;

        return new long[] {gcd, x, y};
    }
}
```

## 八、RSA 为什么难破解

攻击者能看到的是公钥：

$$
(e, N)
$$

在本文的例子中，攻击者知道：

$$
e = 51, \quad N = 2911
$$

如果攻击者能够把 $N$ 分解成：

$$
N = pq
$$

就能进一步算出：

$$
\varphi(N)=(p-1)(q-1)
$$

再根据：

$$
ed \equiv 1 \pmod {\varphi(N)}
$$

求出私钥指数 $d$。

所以 RSA 的安全性主要依赖于一个事实：

> 给定两个大质数 $p$ 和 $q$，计算 $N=pq$ 很容易；但只知道 $N$，想把它重新分解成 $p$ 和 $q$，在经典计算机上非常困难。

本文的 $N=2911$ 太小，很容易被分解：

$$
2911 = 41 \times 71
$$

真实 RSA 会使用非常大的 $N$。当 $N$ 足够大时，攻击者无法在可接受时间内完成因数分解。

不过也要注意：RSA 的安全不只取决于 $N$ 的长度，还取决于随机数质量、填充方案、密钥生成方式、私钥保护、侧信道防护等工程细节。

## 九、容易误解的几点

### 1. RSA 不是用来直接加密大文件的

RSA 计算成本很高，而且一次能加密的数据长度受 $N$ 限制。

真实系统通常这样做：

1. 随机生成一个对称密钥；
2. 用对称密钥加密大文件或通信数据；
3. 用 RSA 加密这个对称密钥，或者用 RSA 做身份认证/数字签名。

### 2. 公钥加密和私钥签名不是一回事

RSA 有两类常见用途：

| 用途 | 使用方式 | 目的 |
| --- | --- | --- |
| 加密 | 公钥加密，私钥解密 | 保护机密性 |
| 签名 | 私钥签名，公钥验签 | 证明身份，防止篡改 |

“公钥加密、私钥解密”和“私钥签名、公钥验签”看起来都在使用同一对密钥，但安全目标不同，使用的填充方案也不同。

### 3. 不要自己实现生产级 RSA

学习时可以手写 RSA 来理解原理，但生产环境不要自己拼装加解密流程。

正确做法是使用成熟密码库，并选择安全方案：

- 加密：RSA-OAEP；
- 签名：RSA-PSS；
- 密钥长度：至少 2048 位，更高安全强度可考虑 3072 位或 4096 位；
- 随机数：使用系统级安全随机数；
- 私钥：使用安全存储，例如 KMS、HSM 或受保护的密钥文件。

## 十、总结

RSA 的核心可以概括为一句话：

> 利用大整数因数分解的困难性，把“容易计算的乘法”和“很难反推的分解”结合起来，构造出一对公钥和私钥。

完整流程如下：

1. 选择两个大质数 $p$ 和 $q$；
2. 计算 $N=pq$；
3. 计算 $\varphi(N)=(p-1)(q-1)$；
4. 选择与 $\varphi(N)$ 互质的公钥指数 $e$；
5. 计算 $e$ 关于 $\varphi(N)$ 的模逆元 $d$；
6. 公钥为 $(e,N)$，私钥为 $(d,N)$；
7. 加密：$C \equiv M^e \pmod N$；
8. 解密：$M \equiv C^d \pmod N$。

数学上，RSA 的正确性来自欧拉定理和中国剩余定理；工程上，RSA 的安全性还依赖安全填充、足够大的密钥、可靠随机数和正确的实现。

## 参考资料

- [R. L. Rivest, A. Shamir, L. Adleman: A Method for Obtaining Digital Signatures and Public-Key Cryptosystems](https://people.csail.mit.edu/rivest/Rsapaper.pdf)
- [NIST SP 800-57 Part 1 Rev. 5: Recommendation for Key Management](https://csrc.nist.gov/pubs/sp/800/57/pt1/r5/final)
- [NIST FIPS 186-5: Digital Signature Standard](https://csrc.nist.gov/pubs/fips/186-5/final)
