// ============================================================
// JMS 搬瓦工订阅转换 - Deno Deploy
// ============================================================

const NODE_NAMES: Record<string, string> = {
  s1: "🇺🇸 洛杉矶 01",
  s2: "🇺🇸 洛杉矶 02",
  s3: "🇺🇸 洛杉矶 03",
  s4: "🇯🇵 日本大阪",
  s5: "🇳🇱 荷兰",
  s801: "🇺🇸 洛杉矶 04｜x0.01倍 省流量平时使用这个",
};

Deno.serve(async (request: Request) => {
  try {
    const url = new URL(request.url);

    // ========================================================
    // 0. 健康检查
    // ========================================================

    if (url.pathname === "/health") {
      return new Response("OK - Deno direct access works", {
        status: 200,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    }

    // ========================================================
    // 1. 读取 Deno Deploy 环境变量
    // ========================================================

    const JMS_SUB_URL = Deno.env.get("JMS_SUB_URL");
    const SUB_TOKEN = Deno.env.get("SUB_TOKEN");
    const JMS_BW_API = Deno.env.get("JMS_BW_API");

    // ========================================================
    // 2. 验证订阅 Token
    // ========================================================

    if (
      !SUB_TOKEN ||
      url.searchParams.get("token") !== SUB_TOKEN
    ) {
      return new Response("Forbidden", {
        status: 403,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    }

    // ========================================================
    // 3. 检查 JMS 官方订阅地址
    // ========================================================

    if (!JMS_SUB_URL) {
      return new Response(
        "JMS_SUB_URL is not configured.",
        {
          status: 500,
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
          },
        },
      );
    }

    // ========================================================
    // 4. 获取 JMS 官方订阅
    // ========================================================

    const upstream = await fetch(JMS_SUB_URL, {
      headers: {
        "User-Agent": "clash-verge",
        "Accept": "*/*",
      },
      redirect: "follow",
    });

    if (!upstream.ok) {
      return new Response(
        `Failed to fetch JMS subscription: ${upstream.status}`,
        {
          status: 502,
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
          },
        },
      );
    }

    let yaml = await upstream.text();

    // ========================================================
    // 5. 修改 Clash 配置
    // ========================================================

    // 节点中文重命名
    yaml = renameJmsNodes(yaml);

    // 完全重建 proxy-groups
    // JMS Auto 不会保留
    yaml = rebuildProxyGroups(yaml);

    // 国内 / 局域网直连，其余 JMS
    yaml = addRoutingRules(yaml);

    // ========================================================
    // 6. 获取 JMS 实时流量
    // ========================================================

    let total: number | null = null;
    let used: number | null = null;
    let resetDay: number | null = null;

    if (JMS_BW_API) {
      try {
        const bwResponse = await fetch(JMS_BW_API, {
          headers: {
            "User-Agent": "Mozilla/5.0",
            "Accept": "application/json",
          },
          redirect: "follow",
        });

        if (bwResponse.ok) {
          const bwData = await bwResponse.json();

          if (
            bwData.monthly_bw_limit_b !== undefined &&
            bwData.bw_counter_b !== undefined
          ) {
            total = Number(bwData.monthly_bw_limit_b);
            used = Number(bwData.bw_counter_b);

            if (
              bwData.bw_reset_day_of_month !== undefined
            ) {
              resetDay = Number(
                bwData.bw_reset_day_of_month,
              );
            }
          }
        } else {
          console.log(
            "JMS bandwidth API HTTP error:",
            bwResponse.status,
          );
        }
      } catch (error) {
        console.log(
          "JMS bandwidth API error:",
          error,
        );
      }
    }

    // ========================================================
    // 7. 生成 Clash Subscription-Userinfo
    // ========================================================

    let subscriptionInfo = "";

    if (
      total !== null &&
      used !== null &&
      Number.isFinite(total) &&
      Number.isFinite(used)
    ) {
      let expire: number | null = null;

      if (
        resetDay !== null &&
        Number.isFinite(resetDay) &&
        resetDay >= 1 &&
        resetDay <= 31
      ) {
        expire = getNextResetTimestamp(resetDay);
      }

      subscriptionInfo =
        `upload=0; download=${Math.floor(used)}; total=${Math.floor(total)}`;

      if (expire) {
        subscriptionInfo += `; expire=${expire}`;
      }
    } else {
      // 流量 API 获取失败时使用 JMS 官方 Header
      subscriptionInfo =
        upstream.headers.get("subscription-userinfo") || "";
    }

    // ========================================================
    // 8. 返回 Clash 配置
    // ========================================================

    const headers = new Headers();

    headers.set(
      "Content-Type",
      "text/yaml; charset=utf-8",
    );

    // Clash 订阅名称：JMS搬瓦工
    headers.set(
      "Content-Disposition",
      "inline; filename*=UTF-8''JMS%E6%90%AC%E7%93%A6%E5%B7%A5.yaml",
    );

    // 6 小时自动更新
    headers.set(
      "Profile-Update-Interval",
      "6",
    );

    // 防止 Deno/CDN 缓存旧订阅
    headers.set(
      "Cache-Control",
      "no-store, no-cache, must-revalidate",
    );

    headers.set(
      "Pragma",
      "no-cache",
    );

    if (subscriptionInfo) {
      headers.set(
        "Subscription-Userinfo",
        subscriptionInfo,
      );
    }

    return new Response(yaml, {
      status: 200,
      headers,
    });
  } catch (error) {
    console.error("Deno subscription error:", error);

    const message =
      error instanceof Error
        ? error.message
        : String(error);

    return new Response(
      "Deno Error: " + message,
      {
        status: 500,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
        },
      },
    );
  }
});


// ============================================================
// 节点自动重命名
//
// 支持：
// c10s1.portablesubmarines.com
// c10s2.portablesubmarines.com
// c70s1.portablesubmarines.com
// 等不同 JMS 前缀
// ============================================================

function renameJmsNodes(yaml: string): string {
  for (
    const [serverId, newName]
    of Object.entries(NODE_NAMES)
  ) {
    const escapedId = escapeRegExp(serverId);

    /*
     * 例如：
     *
     * JMS-xxxx@c10s1.portablesubmarines.com:10268
     *
     * serverId = s1
     *
     * [A-Za-z0-9]* 会匹配 c10
     */

    const pattern = new RegExp(
      `JMS-[^"'\\s,@]+@[A-Za-z0-9]*${escapedId}\\.portablesubmarines\\.com:\\d+`,
      "g",
    );

    yaml = yaml.replace(
      pattern,
      newName,
    );
  }

  return yaml;
}


// ============================================================
// 重建 proxy-groups
//
// 不尝试逐行删除 JMS Auto。
// 直接删除官方整个 proxy-groups 区块，
// 然后建立我们自己的 JMS 手动选择组。
// ============================================================

function rebuildProxyGroups(yaml: string): string {
  const lines = yaml.split(/\r?\n/);

  const proxyIndex = lines.findIndex(
    (line) => /^proxy-groups:\s*$/.test(line),
  );

  if (proxyIndex === -1) {
    return yaml;
  }

  /*
   * 找 proxy-groups 后面的下一个顶级 YAML 区块。
   *
   * 一般就是 rules:
   * 但这样写以后 JMS 官方增加其他区块也不会破坏 YAML。
   */

  let nextTopLevelIndex = -1;

  for (
    let i = proxyIndex + 1;
    i < lines.length;
    i++
  ) {
    const line = lines[i];

    if (
      /^[A-Za-z0-9_-]+:\s*(?:.*)?$/.test(line) &&
      !/^\s/.test(line)
    ) {
      nextTopLevelIndex = i;
      break;
    }
  }

  const newProxyGroups = [
    "proxy-groups:",
    "",
    '- name: "JMS"',
    "  type: select",
    "  proxies:",
    '  - "🇺🇸 洛杉矶 04｜x0.01倍 省流量平时使用这个"',
    '  - "🇺🇸 洛杉矶 01"',
    '  - "🇺🇸 洛杉矶 02"',
    '  - "🇺🇸 洛杉矶 03"',
    '  - "🇯🇵 日本大阪"',
    '  - "🇳🇱 荷兰"',
    "  - DIRECT",
    "",
  ];

  /*
   * 如果 proxy-groups 已经是文件最后一个区块
   */
  if (nextTopLevelIndex === -1) {
    return [
      ...lines.slice(0, proxyIndex),
      ...newProxyGroups,
    ].join("\n");
  }

  return [
    ...lines.slice(0, proxyIndex),
    ...newProxyGroups,
    ...lines.slice(nextTopLevelIndex),
  ].join("\n");
}


// ============================================================
// 国内 / 局域网 DIRECT
// 其他流量 JMS
// ============================================================

function addRoutingRules(yaml: string): string {
  const lines = yaml.split(/\r?\n/);

  const rulesIndex = lines.findIndex(
    (line) => /^rules:\s*$/.test(line),
  );

  const newRules = [
    "rules:",
    '- "GEOSITE,private,DIRECT"',
    '- "GEOIP,private,DIRECT,no-resolve"',
    '- "GEOSITE,CN,DIRECT"',
    '- "GEOIP,CN,DIRECT,no-resolve"',
    '- "MATCH,JMS"',
  ];

  /*
   * 官方没有 rules:
   * 直接追加到文件最后
   */
  if (rulesIndex === -1) {
    return [
      yaml.trimEnd(),
      "",
      ...newRules,
      "",
    ].join("\n");
  }

  /*
   * 找 rules 后面的下一个顶级区块。
   * 目前 JMS 的 rules 通常位于文件末尾，
   * 但这里不依赖这个假设。
   */

  let nextTopLevelIndex = -1;

  for (
    let i = rulesIndex + 1;
    i < lines.length;
    i++
  ) {
    const line = lines[i];

    if (
      /^[A-Za-z0-9_-]+:\s*(?:.*)?$/.test(line) &&
      !/^\s/.test(line)
    ) {
      nextTopLevelIndex = i;
      break;
    }
  }

  if (nextTopLevelIndex === -1) {
    return [
      ...lines.slice(0, rulesIndex),
      ...newRules,
      "",
    ].join("\n");
  }

  return [
    ...lines.slice(0, rulesIndex),
    ...newRules,
    "",
    ...lines.slice(nextTopLevelIndex),
  ].join("\n");
}


// ============================================================
// 下一次流量重置日期
// JMS 使用 Los Angeles 时区
// ============================================================

function getNextResetTimestamp(
  resetDay: number,
): number {
  const parts =
    new Intl.DateTimeFormat(
      "en-US",
      {
        timeZone: "America/Los_Angeles",
        year: "numeric",
        month: "numeric",
        day: "numeric",
      },
    ).formatToParts(new Date());

  const get = (type: string): number => {
    const part =
      parts.find(
        (p) => p.type === type,
      );

    if (!part) {
      throw new Error(
        `Unable to read date part: ${type}`,
      );
    }

    return Number(part.value);
  };

  let year = get("year");
  let month = get("month");
  const day = get("day");

  /*
   * 本月已经到重置日，
   * 下一次重置就是下个月。
   */

  if (day >= resetDay) {
    month++;

    if (month > 12) {
      month = 1;
      year++;
    }
  }

  /*
   * 防止 2 月 30/31 日等不存在日期。
   */

  const lastDay =
    new Date(
      Date.UTC(
        year,
        month,
        0,
      ),
    ).getUTCDate();

  const targetDay =
    Math.min(
      resetDay,
      lastDay,
    );

  /*
   * 使用中午 UTC，
   * 减少时区转换造成日期显示偏一天的问题。
   */

  return Math.floor(
    Date.UTC(
      year,
      month - 1,
      targetDay,
      12,
      0,
      0,
    ) / 1000,
  );
}


// ============================================================
// 正则转义
// ============================================================

function escapeRegExp(
  value: string,
): string {
  return value.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&",
  );
}
