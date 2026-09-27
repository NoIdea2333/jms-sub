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


// ============================================================
// Deno HTTP Server
// ============================================================

Deno.serve(async (request: Request) => {
  try {
    const url = new URL(request.url);


    // ========================================================
    // 0. 健康检查
    // ========================================================

    if (url.pathname === "/health") {
      return new Response(
        "OK - Deno direct access works",
        {
          status: 200,
          headers: {
            "Content-Type":
              "text/plain; charset=utf-8",

            "Cache-Control":
              "no-store",
          },
        },
      );
    }


    // ========================================================
    // 1. 读取 Deno 环境变量
    // ========================================================

    const JMS_SUB_URL =
      Deno.env.get("JMS_SUB_URL");

    const SUB_TOKEN =
      Deno.env.get("SUB_TOKEN");

    const JMS_BW_API =
      Deno.env.get("JMS_BW_API");


    // ========================================================
    // 2. 验证订阅 Token
    // ========================================================

    if (
      !SUB_TOKEN ||
      url.searchParams.get("token") !== SUB_TOKEN
    ) {
      return new Response(
        "Forbidden",
        {
          status: 403,
          headers: {
            "Content-Type":
              "text/plain; charset=utf-8",

            "Cache-Control":
              "no-store",
          },
        },
      );
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
            "Content-Type":
              "text/plain; charset=utf-8",
          },
        },
      );
    }


    // ========================================================
    // 4. 获取 JMS 官方订阅
    // ========================================================

    const upstream =
      await fetch(
        JMS_SUB_URL,
        {
          headers: {
            "User-Agent":
              "clash-verge",

            "Accept":
              "*/*",
          },

          redirect:
            "follow",
        },
      );


    if (!upstream.ok) {
      return new Response(
        `Failed to fetch JMS subscription: ${upstream.status}`,
        {
          status: 502,
          headers: {
            "Content-Type":
              "text/plain; charset=utf-8",
          },
        },
      );
    }


    let yaml =
      await upstream.text();


    // ========================================================
    // 5. 修改 Clash 配置
    // ========================================================

    // 节点中文名称
    yaml =
      renameJmsNodes(yaml);


    // 重建代理组
    // 删除官方 JMS Auto
    // 添加自动故障切换
    yaml =
      rebuildProxyGroups(yaml);


    // 国内直连 / 其他全部 JMS
    yaml =
      addRoutingRules(yaml);


    // ========================================================
    // 6. 获取 JMS 实时流量
    // ========================================================

    let total:
      number | null = null;

    let used:
      number | null = null;

    let resetDay:
      number | null = null;


    if (JMS_BW_API) {
      try {

        const bwResponse =
          await fetch(
            JMS_BW_API,
            {
              headers: {
                "User-Agent":
                  "Mozilla/5.0",

                "Accept":
                  "application/json",
              },

              redirect:
                "follow",
            },
          );


        if (bwResponse.ok) {

          const bwData =
            await bwResponse.json();


          if (
            bwData.monthly_bw_limit_b
              !== undefined &&
            bwData.bw_counter_b
              !== undefined
          ) {

            total =
              Number(
                bwData.monthly_bw_limit_b,
              );


            used =
              Number(
                bwData.bw_counter_b,
              );


            if (
              bwData.bw_reset_day_of_month
                !== undefined
            ) {

              resetDay =
                Number(
                  bwData
                    .bw_reset_day_of_month,
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
    // 7. Clash Subscription-Userinfo
    // ========================================================

    let subscriptionInfo = "";


    if (
      total !== null &&
      used !== null &&
      Number.isFinite(total) &&
      Number.isFinite(used)
    ) {

      let expire:
        number | null = null;


      if (
        resetDay !== null &&
        Number.isFinite(resetDay) &&
        resetDay >= 1 &&
        resetDay <= 31
      ) {

        expire =
          getNextResetTimestamp(
            resetDay,
          );
      }


      subscriptionInfo =
        `upload=0; download=${Math.floor(used)}; total=${Math.floor(total)}`;


      if (expire) {

        subscriptionInfo +=
          `; expire=${expire}`;
      }

    } else {

      // 如果流量 API 失败
      // 使用 JMS 官方 Header

      subscriptionInfo =
        upstream.headers.get(
          "subscription-userinfo",
        ) || "";
    }


    // ========================================================
    // 8. 返回 Clash 配置
    // ========================================================

    const headers =
      new Headers();


    headers.set(
      "Content-Type",
      "text/yaml; charset=utf-8",
    );


    // 订阅名称
    headers.set(
      "Content-Disposition",
      "inline; filename*=UTF-8''JMS%E6%90%AC%E7%93%A6%E5%B7%A5",
    );


    // 6 小时更新
    headers.set(
      "Profile-Update-Interval",
      "6",
    );


    // 禁止缓存旧订阅
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


    return new Response(
      yaml,
      {
        status: 200,
        headers,
      },
    );


  } catch (error) {

    console.error(
      "Deno subscription error:",
      error,
    );


    const message =
      error instanceof Error
        ? error.message
        : String(error);


    return new Response(
      "Deno Error: " + message,
      {
        status: 500,
        headers: {
          "Content-Type":
            "text/plain; charset=utf-8",

          "Cache-Control":
            "no-store",
        },
      },
    );
  }
});


// ============================================================
// 节点自动重命名
//
// 支持：
// c10s1
// c10s2
// c70s1
// 等 JMS 动态前缀
// ============================================================

function renameJmsNodes(
  yaml: string,
): string {

  for (
    const [serverId, newName]
    of Object.entries(NODE_NAMES)
  ) {

    const escapedId =
      escapeRegExp(serverId);


    const pattern =
      new RegExp(
        `JMS-[^"'\\s,@]+@[A-Za-z0-9]*${escapedId}\\.portablesubmarines\\.com:\\d+`,
        "g",
      );


    yaml =
      yaml.replace(
        pattern,
        newName,
      );
  }


  return yaml;
}


// ============================================================
// 重建 proxy-groups
//
// JMS 主组：
// 默认第一项 = 自动故障切换
//
// 自动故障切换：
// 优先使用 x0.01 洛杉矶04
// 不可用时依次切换其他节点
// ============================================================

function rebuildProxyGroups(
  yaml: string,
): string {

  const lines =
    yaml.split(/\r?\n/);


  const proxyIndex =
    lines.findIndex(
      (line) =>
        /^proxy-groups:\s*$/.test(line),
    );


  if (proxyIndex === -1) {
    return yaml;
  }


  // 找 proxy-groups 后面的
  // 下一个顶级 YAML 区块

  let nextTopLevelIndex = -1;


  for (
    let i = proxyIndex + 1;
    i < lines.length;
    i++
  ) {

    const line =
      lines[i];


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


    // ========================================================
    // JMS 主组
    // ========================================================

    '- name: "JMS"',

    "  type: select",

    "  proxies:",


    // 第一项
    // 新导入时优先自动故障切换

    '  - "🔄 自动故障切换"',


    // 手动节点

    '  - "🇺🇸 洛杉矶 04｜x0.01倍 省流量平时使用这个"',

    '  - "🇺🇸 洛杉矶 01"',

    '  - "🇺🇸 洛杉矶 02"',

    '  - "🇺🇸 洛杉矶 03"',

    '  - "🇯🇵 日本大阪"',

    '  - "🇳🇱 荷兰"',

    "  - DIRECT",

    "",


    // ========================================================
    // 自动故障切换
    // ========================================================

    '- name: "🔄 自动故障切换"',

    "  type: fallback",

    "  proxies:",


    // 第一优先
    // x0.01 省流量节点

    '  - "🇺🇸 洛杉矶 04｜x0.01倍 省流量平时使用这个"',


    // 后备节点

    '  - "🇺🇸 洛杉矶 01"',

    '  - "🇺🇸 洛杉矶 02"',

    '  - "🇺🇸 洛杉矶 03"',

    '  - "🇯🇵 日本大阪"',

    '  - "🇳🇱 荷兰"',


    // 测试地址

    '  url: "https://www.gstatic.com/generate_204"',


    // 每 5 分钟检测一次

    "  interval: 300",

    "",
  ];


  if (
    nextTopLevelIndex === -1
  ) {

    return [
      ...lines.slice(
        0,
        proxyIndex,
      ),

      ...newProxyGroups,

    ].join("\n");
  }


  return [

    ...lines.slice(
      0,
      proxyIndex,
    ),

    ...newProxyGroups,

    ...lines.slice(
      nextTopLevelIndex,
    ),

  ].join("\n");
}


// ============================================================
// 国内直连 / 国外代理
//
// 局域网 / 私有地址 → DIRECT
// 中国大陆          → DIRECT
// 其他所有流量      → JMS
//
// JMS 默认：🔄 自动故障切换
//
// 因此：
// 国内流量 → 不消耗 JMS
// 国外流量 → JMS
// 洛杉矶04不可用 → 自动切换其他节点
// ============================================================

function addRoutingRules(
  yaml: string,
): string {

  const lines =
    yaml.split(/\r?\n/);


  const rulesIndex =
    lines.findIndex(
      (line) =>
        /^rules:\s*$/.test(line),
    );


  const newRules = [

    "rules:",


    // ========================================================
    // 局域网 / 私有地址
    // ========================================================

    '- "GEOSITE,private,DIRECT"',

    '- "GEOIP,private,DIRECT,no-resolve"',


    // ========================================================
    // 中国大陆网站
    // ========================================================

    '- "GEOSITE,CN,DIRECT"',


    // ========================================================
    // 中国大陆 IP
    // ========================================================

    '- "GEOIP,CN,DIRECT,no-resolve"',


    // ========================================================
    // 其余所有流量
    //
    // ChatGPT / OpenAI
    // TikTok
    // Google
    // YouTube
    // Instagram
    // Facebook
    // X / Twitter
    // Telegram
    // 以及其他未命中中国大陆规则的流量
    // ========================================================

    '- "MATCH,JMS"',
  ];


  // ==========================================================
  // 官方配置不存在 rules:
  // ==========================================================

  if (rulesIndex === -1) {

    return [

      yaml.trimEnd(),

      "",

      ...newRules,

      "",

    ].join("\n");
  }


  // ==========================================================
  // 找 rules 后面的下一个顶级区块
  // ==========================================================

  let nextTopLevelIndex = -1;


  for (
    let i = rulesIndex + 1;
    i < lines.length;
    i++
  ) {

    const line =
      lines[i];


    if (
      /^[A-Za-z0-9_-]+:\s*(?:.*)?$/.test(line) &&
      !/^\s/.test(line)
    ) {

      nextTopLevelIndex = i;

      break;
    }
  }


  // ==========================================================
  // rules 位于文件末尾
  // ==========================================================

  if (
    nextTopLevelIndex === -1
  ) {

    return [

      ...lines.slice(
        0,
        rulesIndex,
      ),

      ...newRules,

      "",

    ].join("\n");
  }


  // ==========================================================
  // rules 后面还有其他区块
  // ==========================================================

  return [

    ...lines.slice(
      0,
      rulesIndex,
    ),

    ...newRules,

    "",

    ...lines.slice(
      nextTopLevelIndex,
    ),

  ].join("\n");
}


// ============================================================
// 下一次 JMS 流量重置日期
//
// 使用 Los Angeles 时区
// ============================================================

function getNextResetTimestamp(
  resetDay: number,
): number {

  const parts =
    new Intl.DateTimeFormat(
      "en-US",
      {
        timeZone:
          "America/Los_Angeles",

        year:
          "numeric",

        month:
          "numeric",

        day:
          "numeric",
      },
    ).formatToParts(
      new Date(),
    );


  const get =
    (type: string): number => {

      const part =
        parts.find(
          (p) =>
            p.type === type,
        );


      if (!part) {

        throw new Error(
          `Unable to read date part: ${type}`,
        );
      }


      return Number(
        part.value,
      );
    };


  let year =
    get("year");


  let month =
    get("month");


  const day =
    get("day");


  // ==========================================================
  // 本月已经达到重置日
  // 下一次 = 下个月
  // ==========================================================

  if (
    day >= resetDay
  ) {

    month++;


    if (
      month > 12
    ) {

      month = 1;

      year++;
    }
  }


  // ==========================================================
  // 防止 2月30 / 2月31 等不存在日期
  // ==========================================================

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


  // ==========================================================
  // 使用中午 UTC
  // 减少 Clash 日期显示偏一天的问题
  // ==========================================================

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
